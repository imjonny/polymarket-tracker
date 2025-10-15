// server.js - Polymarket Whale Tracker with Blockchain Scraper
// Monitors Polymarket trades directly from Polygon blockchain

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const CONFIG = {
  MIN_TRADE_SIZE: parseInt(process.env.MIN_TRADE_SIZE) || 10000,
  MAX_ACCOUNT_AGE_DAYS: parseInt(process.env.MAX_ACCOUNT_AGE_DAYS) || 7,
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK || '',
  POLL_INTERVAL: 15000, // 15 seconds
  
  // Polymarket Contracts on Polygon
  CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  CONDITIONAL_TOKENS: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
  
  // Polygon RPC
  POLYGON_RPC: process.env.POLYGON_RPC || 'https://polygon-rpc.com',
  
  // APIs
  GAMMA_API: 'https://gamma-api.polymarket.com',
  POLYGONSCAN_KEY: process.env.POLYGONSCAN_API_KEY || 'YourApiKeyToken'
};

// In-memory storage
const recentTrades = [];
const seenTxHashes = new Set();
const marketCache = new Map();
let lastBlockChecked = 0;

// Initialize Polygon provider
const provider = new ethers.JsonRpcProvider(CONFIG.POLYGON_RPC);

// CTF Exchange ABI (OrderFilled event)
const CTF_EXCHANGE_ABI = [
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)'
];

const ctfExchange = new ethers.Contract(CONFIG.CTF_EXCHANGE, CTF_EXCHANGE_ABI, provider);

// Get market info from Gamma API
async function getMarketInfo(tokenId) {
  if (marketCache.has(tokenId)) {
    return marketCache.get(tokenId);
  }
  
  try {
    const response = await axios.get(`${CONFIG.GAMMA_API}/markets`);
    if (Array.isArray(response.data)) {
      for (const market of response.data) {
        const tokens = market.clobTokenIds || [];
        if (tokens.includes(tokenId)) {
          const info = {
            question: market.question || market.title,
            slug: market.slug
          };
          marketCache.set(tokenId, info);
          return info;
        }
      }
    }
  } catch (error) {
    console.error('Error fetching market info:', error.message);
  }
  
  return { question: 'Unknown Market', slug: '' };
}

// Check wallet age on Polygon
async function getWalletAge(address) {
  try {
    const response = await axios.get('https://api.polygonscan.com/api', {
      params: {
        module: 'account',
        action: 'txlist',
        address: address,
        startblock: 0,
        endblock: 99999999,
        page: 1,
        offset: 1,
        sort: 'asc',
        apikey: CONFIG.POLYGONSCAN_KEY
      },
      timeout: 8000
    });
    
    if (response.data.status === '1' && response.data.result.length > 0) {
      const firstTxTimestamp = parseInt(response.data.result[0].timeStamp);
      const ageInDays = (Date.now() / 1000 - firstTxTimestamp) / 86400;
      return Math.floor(ageInDays);
    }
    
    // No transactions found - brand new wallet!
    return 0;
  } catch (error) {
    console.error('Wallet age check error:', error.message);
    // If we can't check, assume it's new to be safe
    return 0;
  }
}

// Send Discord alert
async function sendDiscordAlert(trade) {
  if (!CONFIG.DISCORD_WEBHOOK) {
    console.log('⚠️  Discord webhook not configured');
    return;
  }
  
  try {
    const accountAgeEmoji = trade.accountAge <= 1 ? '🆕' : trade.accountAge <= 7 ? '⚠️' : '✅';
    const outcomeEmoji = trade.outcome === 'YES' ? '📈' : '📉';
    const outcomeColor = trade.outcome === 'YES' ? 0x00FF00 : 0xFF0000; // Green for YES, Red for NO
    
    const embed = {
      title: '🐋 WHALE ALERT - New Account Large Trade!',
      color: outcomeColor,
      fields: [
        { 
          name: '📊 Market', 
          value: trade.market || 'Loading...', 
          inline: false 
        },
        { 
          name: `${outcomeEmoji} Betting On`, 
          value: `**${trade.outcome}**`, 
          inline: true 
        },
        { 
          name: '💰 Trade Amount', 
          value: `**${trade.amount.toLocaleString()}**`, 
          inline: true 
        },
        { 
          name: `${accountAgeEmoji} Account Age`, 
          value: `**${trade.accountAge} days**`, 
          inline: true 
        },
        { 
          name: '👤 Trader Wallet', 
          value: `\`${trade.maker.slice(0, 8)}...${trade.maker.slice(-6)}\``, 
          inline: false 
        },
        { 
          name: '🔗 Transaction', 
          value: `[View on Polygonscan](https://polygonscan.com/tx/${trade.txHash})`, 
          inline: false 
        }
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'Polymarket Whale Tracker | Live Blockchain Monitoring' }
    };

    await axios.post(CONFIG.DISCORD_WEBHOOK, { 
      content: `@everyone 🚨 **NEW WHALE DETECTED!** Account less than ${CONFIG.MAX_ACCOUNT_AGE_DAYS} days old made a **${trade.amount.toLocaleString()}** trade betting **${trade.outcome}**!`,
      embeds: [embed] 
    });
    
    console.log(`✅ Discord alert sent! $${trade.amount.toFixed(0)} from ${trade.accountAge}d old account`);
  } catch (error) {
    console.error('❌ Discord alert failed:', error.message);
  }
}

// Process OrderFilled event
async function processTradeEvent(event) {
  try {
    const txHash = event.transactionHash;
    
    if (seenTxHashes.has(txHash)) return;
    seenTxHashes.add(txHash);
    
    const maker = event.args.maker;
    const taker = event.args.taker;
    const makerAssetId = event.args.makerAssetId.toString();
    const takerAssetId = event.args.takerAssetId.toString();
    const makerAmount = ethers.formatUnits(event.args.makerAmountFilled, 6); // USDC has 6 decimals
    const takerAmount = ethers.formatUnits(event.args.takerAmountFilled, 6);
    
    // Trade size is the larger of the two amounts
    const tradeSize = Math.max(parseFloat(makerAmount), parseFloat(takerAmount));
    
    // Determine which side they're buying (YES or NO)
    // In Polymarket, lower token ID is typically YES, higher is NO
    const isBuyingYes = makerAssetId < takerAssetId;
    const outcome = isBuyingYes ? 'YES' : 'NO';
    
    // Filter by minimum trade size
    if (tradeSize < CONFIG.MIN_TRADE_SIZE) return;
    
    console.log(`📊 Large trade detected: $${tradeSize.toFixed(0)}`);
    
    // Check both maker and taker wallet ages
    const makerAge = await getWalletAge(maker);
    const takerAge = await getWalletAge(taker);
    
    // Check if either party is a new account
    if (makerAge > CONFIG.MAX_ACCOUNT_AGE_DAYS && takerAge > CONFIG.MAX_ACCOUNT_AGE_DAYS) {
      console.log(`   Skipped: Both accounts too old (${makerAge}d, ${takerAge}d)`);
      return;
    }
    
    // Determine which account is new
    const isNewAccount = makerAge <= CONFIG.MAX_ACCOUNT_AGE_DAYS || takerAge <= CONFIG.MAX_ACCOUNT_AGE_DAYS;
    const newAccountAddress = makerAge <= CONFIG.MAX_ACCOUNT_AGE_DAYS ? maker : taker;
    const accountAge = Math.min(makerAge, takerAge);
    
    if (!isNewAccount) return;
    
    console.log(`🐋 NEW WHALE: ${tradeSize.toFixed(0)} from ${accountAge}d old account!`);
    
    // Get block timestamp to show how recent the trade is
    const block = await provider.getBlock(event.blockNumber);
    const tradeTime = new Date(block.timestamp * 1000);
    const secondsAgo = Math.floor((Date.now() - tradeTime.getTime()) / 1000);
    
    console.log(`   Trade happened ${secondsAgo} seconds ago`);
    
    // Get market info
    const tokenId = event.args.makerAssetId.toString();
    const marketInfo = await getMarketInfo(tokenId);
    
    const trade = {
      id: txHash,
      timestamp: new Date(),
      txHash: txHash,
      maker: newAccountAddress,
      amount: tradeSize,
      accountAge: accountAge,
      outcome: outcome,
      market: marketInfo.question,
      marketSlug: marketInfo.slug,
      blockNumber: event.blockNumber
    };
    
    recentTrades.unshift(trade);
    
    if (recentTrades.length > 100) {
      recentTrades.pop();
    }
    
    // Send Discord alert!
    await sendDiscordAlert(trade);
    
  } catch (error) {
    console.error('Error processing trade:', error.message);
  }
}

// Monitor blockchain for new trades
async function monitorBlockchain() {
  try {
    const currentBlock = await provider.getBlockNumber();
    
    if (lastBlockChecked === 0) {
      lastBlockChecked = currentBlock; // Start from current block only
      console.log(`🔍 Starting blockchain monitoring from block ${lastBlockChecked} (live mode)`);
      console.log(`⚠️  Only NEW trades from this point forward will trigger alerts`);
      return; // Skip first cycle to avoid alerting on old trades
    }
    
    if (currentBlock <= lastBlockChecked) {
      return; // No new blocks
    }
    
    console.log(`📦 Checking blocks ${lastBlockChecked + 1} to ${currentBlock}...`);
    
    // Query OrderFilled events
    const filter = ctfExchange.filters.OrderFilled();
    const events = await ctfExchange.queryFilter(filter, lastBlockChecked + 1, currentBlock);
    
    console.log(`   Found ${events.length} trades in ${currentBlock - lastBlockChecked} blocks`);
    
    for (const event of events) {
      await processTradeEvent(event);
    }
    
    lastBlockChecked = currentBlock;
    
  } catch (error) {
    console.error('❌ Blockchain monitoring error:', error.message);
  }
}

// API Endpoints
app.get('/api/trades', (req, res) => {
  res.json({
    trades: recentTrades,
    count: recentTrades.length,
    config: {
      minTradeSize: CONFIG.MIN_TRADE_SIZE,
      maxAccountAge: CONFIG.MAX_ACCOUNT_AGE_DAYS
    }
  });
});

app.get('/api/stats', (req, res) => {
  const totalVolume = recentTrades.reduce((sum, t) => sum + t.amount, 0);
  const avgTradeSize = recentTrades.length > 0 ? totalVolume / recentTrades.length : 0;
  
  res.json({
    totalTrades: recentTrades.length,
    totalVolume: totalVolume,
    avgTradeSize: avgTradeSize,
    lastUpdate: recentTrades[0]?.timestamp || null,
    lastBlock: lastBlockChecked,
    mode: 'blockchain-scraper'
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    whaleTradesDetected: recentTrades.length,
    lastBlock: lastBlockChecked,
    mode: 'blockchain-monitoring'
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Polymarket Whale Tracker - BLOCKCHAIN EDITION`);
  console.log(`📊 Min trade size: $${CONFIG.MIN_TRADE_SIZE.toLocaleString()}`);
  console.log(`⏰ Max account age: ${CONFIG.MAX_ACCOUNT_AGE_DAYS} days`);
  console.log(`🔔 Discord alerts: ${CONFIG.DISCORD_WEBHOOK ? '✅ ENABLED' : '❌ Disabled'}`);
  console.log(`⛓️  Monitoring Polygon blockchain for CTF Exchange trades...`);
  console.log(`📍 CTF Exchange: ${CONFIG.CTF_EXCHANGE}`);
  console.log('');
  
  // Start monitoring
  monitorBlockchain();
  setInterval(monitorBlockchain, CONFIG.POLL_INTERVAL);
});

process.on('SIGTERM', () => {
  console.log('👋 Shutting down');
  process.exit(0);
});
