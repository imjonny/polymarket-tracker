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
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK || '',
  POLL_INTERVAL: 30000, // 30 seconds
  POLYMARKET_CLOB_API: 'https://clob.polymarket.com',
  POLYMARKET_GAMMA_API: 'https://gamma-api.polymarket.com'
};

// In-memory storage for recent trades
const recentTrades = [];
const seenTradeIds = new Set();
const trackedMarkets = new Set();

// Get active markets
async function getActiveMarkets() {
  try {
    const response = await axios.get(`${CONFIG.POLYMARKET_GAMMA_API}/markets`, {
      params: {
        limit: 20,
        active: true,
        closed: false
      }
    });
    
    if (Array.isArray(response.data)) {
      return response.data;
    }
    
    console.log('Markets response format:', typeof response.data);
    return [];
  } catch (error) {
    console.error('Error fetching markets:', error.message);
    return [];
  }
}

// Get trades for a specific market
async function getMarketTrades(conditionId) {
  try {
    const response = await axios.get(`${CONFIG.POLYMARKET_CLOB_API}/trades`, {
      params: {
        market: conditionId,
        limit: 50
      }
    });
    return Array.isArray(response.data) ? response.data : [];
  } catch (error) {
    console.error(`Error fetching trades for ${conditionId}:`, error.message);
    return [];
  }
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
        apikey: process.env.POLYGONSCAN_API_KEY || 'YourApiKeyToken'
      },
      timeout: 5000
    });
    
    if (response.data.status === '1' && response.data.result.length > 0) {
      const firstTxTimestamp = parseInt(response.data.result[0].timeStamp);
      const ageInDays = (Date.now() / 1000 - firstTxTimestamp) / 86400;
      return Math.floor(ageInDays);
    }
    return 0;
  } catch (error) {
    console.error(`Error checking wallet age:`, error.message);
    return null;
  }
}

// Send Discord notification
async function sendDiscordAlert(trade) {
  if (!CONFIG.DISCORD_WEBHOOK) {
    console.log('No Discord webhook configured');
    return;
  }
  
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

    await axios.post(CONFIG.DISCORD_WEBHOOK, { embeds: [embed] });
    console.log('✅ Discord alert sent for trade:', trade.amount);
  } catch (error) {
    console.error('Error sending Discord notification:', error.message);
  }
}

// Process and filter trades
async function processTrade(trade, marketName, marketSlug) {
  const tradeId = `${trade.id || trade.transaction_hash}`;
  
  if (seenTradeIds.has(tradeId)) return null;
  
  const size = parseFloat(trade.size || 0);
  const price = parseFloat(trade.price || 0);
  const amount = size * price;
  
  if (amount < CONFIG.MIN_TRADE_SIZE) return null;
  
  const accountAge = await getWalletAge(trade.maker_address || trade.trader_address);
  if (accountAge === null || accountAge > CONFIG.MAX_ACCOUNT_AGE_DAYS) return null;
  
  const processedTrade = {
    id: tradeId,
    timestamp: new Date(trade.created_at || trade.timestamp || Date.now()),
    market: marketName || marketSlug || 'Unknown Market',
    outcome: trade.side === 'BUY' ? 'YES' : 'NO',
    amount: amount,
    price: price.toFixed(2),
    address: trade.maker_address || trade.trader_address,
    accountAge: accountAge,
    txHash: trade.transaction_hash
  };
  
  seenTradeIds.add(tradeId);
  recentTrades.unshift(processedTrade);
  
  if (recentTrades.length > 100) {
    recentTrades.pop();
  }
  
  console.log(`🐋 Large trade detected: $${amount.toFixed(0)} on ${marketName}`);
  await sendDiscordAlert(processedTrade);
  
  return processedTrade;
}

// Main monitoring loop
async function monitorTrades() {
  console.log('🔍 Starting trade monitoring cycle...');
  
  try {
    const markets = await getActiveMarkets();
    
    if (!markets || markets.length === 0) {
      console.log('⚠️  No markets found, will retry...');
      return;
    }
    
    console.log(`📊 Monitoring ${Math.min(markets.length, 10)} active markets`);
    
    for (const market of markets.slice(0, 10)) {
      try {
        const conditionId = market.condition_id || market.clobTokenIds?.[0];
        const marketName = market.question || market.title;
        
        if (!conditionId) continue;
        
        if (!trackedMarkets.has(conditionId)) {
          console.log(`📈 Tracking: ${marketName}`);
          trackedMarkets.add(conditionId);
        }
        
        const trades = await getMarketTrades(conditionId);
        
        for (const trade of trades) {
          await processTrade(trade, marketName, market.slug);
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (err) {
        console.error('Error processing market:', err.message);
      }
    }
    
    console.log(`✅ Monitoring cycle complete. Tracking ${recentTrades.length} whale trades`);
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
    lastUpdate: recentTrades[0]?.timestamp || null,
    trackedMarkets: trackedMarkets.size
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
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    trackedTrades: recentTrades.length,
    trackedMarkets: trackedMarkets.size
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Polymarket Whale Tracker running on port ${PORT}`);
  console.log(`📊 Min trade size: $${CONFIG.MIN_TRADE_SIZE}`);
  console.log(`⏰ Max account age: ${CONFIG.MAX_ACCOUNT_AGE_DAYS} days`);
  console.log(`🔔 Discord alerts: ${CONFIG.DISCORD_WEBHOOK ? 'Enabled' : 'Disabled'}`);
  
  monitorTrades();
  setInterval(monitorTrades, CONFIG.POLL_INTERVAL);
});

process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully');
  process.exit(0);
});
