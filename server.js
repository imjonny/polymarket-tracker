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
  POLL_INTERVAL: 45000, // 45 seconds
  GAMMA_API: 'https://gamma-api.polymarket.com',
  STRAPI_API: 'https://strapi-matic.poly.market'
};

// In-memory storage
const recentTrades = [];
const seenTradeIds = new Set();
const trackedMarkets = new Map();

// Get active markets with event data
async function getActiveMarkets() {
  try {
    const response = await axios.get(`${CONFIG.GAMMA_API}/markets`, {
      params: {
        limit: 20,
        active: true,
        closed: false,
        order: 'volume24hr',
        ascending: false
      },
      timeout: 10000
    });
    
    if (Array.isArray(response.data)) {
      return response.data.filter(m => m.volume24hr > 1000);
    }
    return [];
  } catch (error) {
    console.error('Error fetching markets:', error.message);
    return [];
  }
}

// Get recent events (trades) from Strapi API
async function getRecentEvents(tokenId) {
  try {
    const response = await axios.get(`${CONFIG.STRAPI_API}/markets/${tokenId}`, {
      timeout: 10000
    });
    
    if (response.data && response.data.events) {
      return response.data.events;
    }
    return [];
  } catch (error) {
    // Strapi API might not have all markets, that's ok
    return [];
  }
}

// Alternative: Get market activity from Gamma API events
async function getMarketEvents(conditionId) {
  try {
    const response = await axios.get(`${CONFIG.GAMMA_API}/events`, {
      params: {
        market: conditionId,
        limit: 50
      },
      timeout: 10000
    });
    
    if (Array.isArray(response.data)) {
      return response.data.filter(e => 
        e.event_type === 'trade' || 
        e.event_type === 'order_matched'
      );
    }
    return [];
  } catch (error) {
    // Events endpoint might not be available
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
      timeout: 8000
    });
    
    if (response.data.status === '1' && response.data.result.length > 0) {
      const firstTxTimestamp = parseInt(response.data.result[0].timeStamp);
      const ageInDays = (Date.now() / 1000 - firstTxTimestamp) / 86400;
      return Math.floor(ageInDays);
    }
    return 0;
  } catch (error) {
    console.error(`Wallet age check failed:`, error.message);
    // If we can't verify age, assume it's new (be conservative)
    return 0;
  }
}

// Send Discord notification
async function sendDiscordAlert(trade) {
  if (!CONFIG.DISCORD_WEBHOOK) {
    console.log('⚠️  No Discord webhook configured');
    return;
  }
  
  try {
    const embed = {
      title: '🐋 Large Trade Alert!',
      color: trade.outcome === 'YES' ? 0x00ff00 : 0xff0000,
      fields: [
        { name: '📊 Market', value: trade.market, inline: false },
        { name: '📈 Outcome', value: trade.outcome, inline: true },
        { name: '💰 Amount', value: `$${trade.amount.toLocaleString()}`, inline: true },
        { name: '💵 Price', value: `$${trade.price}`, inline: true },
        { name: '👤 Wallet', value: `\`${trade.address.slice(0, 8)}...${trade.address.slice(-6)}\``, inline: true },
        { name: '🕐 Account Age', value: `${trade.accountAge} days`, inline: true },
        { name: '🔗 View', value: `[Polymarket](https://polymarket.com)`, inline: true }
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'Polymarket Whale Tracker' }
    };

    await axios.post(CONFIG.DISCORD_WEBHOOK, { embeds: [embed] });
    console.log(`✅ Discord alert sent: $${trade.amount.toFixed(0)}`);
  } catch (error) {
    console.error('❌ Discord notification failed:', error.message);
  }
}

// Simulate trade detection from market data changes
async function detectLargeTrades(market) {
  try {
    const conditionId = market.condition_id || market.clobTokenIds?.[0];
    if (!conditionId) return;
    
    const currentVolume = parseFloat(market.volume24hr || 0);
    const lastVolume = trackedMarkets.get(conditionId) || currentVolume;
    const volumeIncrease = currentVolume - lastVolume;
    
    trackedMarkets.set(conditionId, currentVolume);
    
    // If volume increased significantly, check for large trades
    if (volumeIncrease > CONFIG.MIN_TRADE_SIZE) {
      console.log(`📊 Large volume spike detected: $${volumeIncrease.toFixed(0)} on ${market.question}`);
      
      // Create a simulated trade event for significant volume changes
      // In production, you'd need Polymarket API key to get real trade data
      const mockTrade = {
        id: `${conditionId}-${Date.now()}`,
        timestamp: new Date(),
        market: market.question || market.title,
        outcome: 'UNKNOWN', // Can't determine without trade data
        amount: volumeIncrease,
        price: '0.00',
        address: '0x' + '0'.repeat(40), // Placeholder
        accountAge: 0, // Would need to check real address
        note: 'Volume-based detection (API key needed for detailed trade data)'
      };
      
      if (!seenTradeIds.has(mockTrade.id)) {
        seenTradeIds.add(mockTrade.id);
        recentTrades.unshift(mockTrade);
        
        if (recentTrades.length > 100) {
          recentTrades.pop();
        }
        
        // Note: Discord alerts disabled for volume-based detection
        console.log('⚠️  Note: Full trade tracking requires Polymarket API key');
      }
    }
  } catch (error) {
    console.error('Error detecting trades:', error.message);
  }
}

// Main monitoring loop
async function monitorTrades() {
  console.log('🔍 Starting monitoring cycle...');
  
  try {
    const markets = await getActiveMarkets();
    
    if (!markets || markets.length === 0) {
      console.log('⚠️  No markets found');
      return;
    }
    
    console.log(`📊 Monitoring ${markets.length} markets (Top volume)`);
    
    let checkedCount = 0;
    for (const market of markets.slice(0, 15)) {
      try {
        await detectLargeTrades(market);
        checkedCount++;
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (err) {
        console.error('Error processing market:', err.message);
      }
    }
    
    console.log(`✅ Checked ${checkedCount} markets. Tracked events: ${recentTrades.length}`);
  } catch (error) {
    console.error('❌ Monitoring error:', error.message);
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
    },
    note: 'Full trade tracking requires Polymarket API access'
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
    trackedMarkets: trackedMarkets.size,
    status: 'Volume monitoring active (API key needed for full trade data)'
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    trackedEvents: recentTrades.length,
    trackedMarkets: trackedMarkets.size,
    mode: 'volume-monitoring'
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Polymarket Whale Tracker v2.0`);
  console.log(`📊 Min trade size: $${CONFIG.MIN_TRADE_SIZE}`);
  console.log(`⏰ Max account age: ${CONFIG.MAX_ACCOUNT_AGE_DAYS} days`);
  console.log(`🔔 Discord: ${CONFIG.DISCORD_WEBHOOK ? 'Configured' : 'Not configured'}`);
  console.log(`⚠️  Running in VOLUME MONITORING mode`);
  console.log(`💡 For full trade tracking, Polymarket API key is required`);
  
  monitorTrades();
  setInterval(monitorTrades, CONFIG.POLL_INTERVAL);
});

process.on('SIGTERM', () => {
  console.log('👋 Shutting down');
  process.exit(0);
});
