// server.js - Polymarket Whale Tracker Backend
// Run with: node server.js

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const CONFIG = {
  MIN_TRADE_SIZE: process.env.MIN_TRADE_SIZE || 10000,
  MAX_ACCOUNT_AGE_DAYS: process.env.MAX_ACCOUNT_AGE_DAYS || 7,
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK || '', // Add your Discord webhook
  POLL_INTERVAL: 10000, // 10 seconds
  POLYMARKET_API: 'https://clob.polymarket.com',
  POLYGON_RPC: process.env.POLYGON_RPC || 'https://polygon-rpc.com'
};

// In-memory storage for recent trades
const recentTrades = [];
const seenTradeIds = new Set();

// Polymarket API Functions
async function getActiveMarkets() {
  try {
    const response = await axios.get(`${CONFIG.POLYMARKET_API}/markets`);
    return response.data;
  } catch (error) {
    console.error('Error fetching markets:', error.message);
    return [];
  }
}

async function getMarketTrades(marketId) {
  try {
    const response = await axios.get(`${CONFIG.POLYMARKET_API}/trades`, {
      params: {
        market: marketId,
        limit: 20
      }
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching trades for market ${marketId}:`, error.message);
    return [];
  }
}

async function getWalletAge(address) {
  try {
    // Query Polygon blockchain for first transaction
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
        apikey: process.env.POLYGONSCAN_API_KEY || 'YourApiKeyToken'
      }
    });
    
    if (response.data.status === '1' && response.data.result.length > 0) {
      const firstTxTimestamp = parseInt(response.data.result[0].timeStamp);
      const ageInDays = (Date.now() / 1000 - firstTxTimestamp) / 86400;
      return Math.floor(ageInDays);
    }
    return 0; // New account
  } catch (error) {
    console.error(`Error checking wallet age for ${address}:`, error.message);
    return null;
  }
}

// Send Discord notification
async function sendDiscordAlert(trade) {
  if (!CONFIG.DISCORD_WEBHOOK) return;
  
  try {
    const embed = {
      title: '🐋 Large Trade Detected!',
      color: trade.outcome === 'YES' ? 0x00ff00 : 0xff0000,
      fields: [
        { name: 'Market', value: trade.market, inline: false },
        { name: 'Outcome', value: trade.outcome, inline: true },
        { name: 'Amount', value: `$${trade.amount.toLocaleString()}`, inline: true },
        { name: 'Price', value: `$${trade.price}`, inline: true },
        { name: 'Wallet', value: `\`${trade.address.slice(0, 10)}...${trade.address.slice(-8)}\``, inline: true },
        { name: 'Account Age', value: `${trade.accountAge} days`, inline: true }
      ],
      timestamp: new Date().toISOString()
    };

    await axios.post(CONFIG.DISCORD_WEBHOOK, {
      embeds: [embed]
    });
  } catch (error) {
    console.error('Error sending Discord notification:', error.message);
  }
}

// Process and filter trades
async function processTrade(trade, marketName) {
  const tradeId = `${trade.id}-${trade.trader_address}`;
  
  // Skip if already seen
  if (seenTradeIds.has(tradeId)) return null;
  
  const amount = parseFloat(trade.size) * parseFloat(trade.price);
  
  // Filter by minimum size
  if (amount < CONFIG.MIN_TRADE_SIZE) return null;
  
  // Check wallet age
  const accountAge = await getWalletAge(trade.trader_address);
  if (accountAge === null || accountAge > CONFIG.MAX_ACCOUNT_AGE_DAYS) return null;
  
  const processedTrade = {
    id: tradeId,
    timestamp: new Date(trade.timestamp),
    market: marketName,
    outcome: trade.side === 'BUY' ? 'YES' : 'NO',
    amount: amount,
    price: parseFloat(trade.price).toFixed(2),
    address: trade.trader_address,
    accountAge: accountAge,
    txHash: trade.transaction_hash
  };
  
  seenTradeIds.add(tradeId);
  recentTrades.unshift(processedTrade);
  
  // Keep only last 100 trades in memory
  if (recentTrades.length > 100) {
    recentTrades.pop();
  }
  
  // Send alert
  await sendDiscordAlert(processedTrade);
  
  return processedTrade;
}

// Main monitoring loop
async function monitorTrades() {
  console.log('🔍 Starting trade monitoring...');
  
  try {
    const markets = await getActiveMarkets();
    console.log(`Monitoring ${markets.length} markets`);
    
    for (const market of markets.slice(0, 10)) { // Monitor top 10 markets
      const trades = await getMarketTrades(market.condition_id);
      
      for (const trade of trades) {
        await processTrade(trade, market.question);
      }
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) {
    console.error('Error in monitoring loop:', error.message);
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
    lastUpdate: recentTrades[0]?.timestamp || null
  });
});

app.post('/api/config', (req, res) => {
  const { minTradeSize, maxAccountAge, discordWebhook } = req.body;
  
  if (minTradeSize) CONFIG.MIN_TRADE_SIZE = minTradeSize;
  if (maxAccountAge) CONFIG.MAX_ACCOUNT_AGE_DAYS = maxAccountAge;
  if (discordWebhook) CONFIG.DISCORD_WEBHOOK = discordWebhook;
  
  res.json({ success: true, config: CONFIG });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  
  // Start monitoring
  monitorTrades();
  setInterval(monitorTrades, CONFIG.POLL_INTERVAL);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received, shutting down gracefully');
  process.exit(0);
});
