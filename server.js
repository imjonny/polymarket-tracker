// server.js - Kalshi Whale Tracker
// Monitors Kalshi for large trades

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const CONFIG = {
  MIN_TRADE_SIZE: parseInt(process.env.MIN_TRADE_SIZE) || 15000,
  VOLUME_SPIKE_THRESHOLD: parseInt(process.env.VOLUME_SPIKE_THRESHOLD) || 50000,
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK || '',
  POLL_INTERVAL: 30000, // 30 seconds
  KALSHI_API: 'https://api.elections.kalshi.com/trade-api/v2'
};

// In-memory storage
const recentWhales = [];
const marketCache = new Map();
const seenAlerts = new Set();

// Get active markets
async function getActiveMarkets() {
  try {
    const response = await axios.get(`${CONFIG.KALSHI_API}/markets`, {
      params: {
        status: 'open',
        limit: 100
      },
      timeout: 10000
    });
    
    return response.data.markets || [];
  } catch (error) {
    console.error('❌ Error fetching markets:', error.message);
    return [];
  }
}

// Get orderbook for a specific market
async function getOrderbook(ticker) {
  try {
    const response = await axios.get(`${CONFIG.KALSHI_API}/markets/${ticker}/orderbook`, {
      timeout: 10000
    });
    
    return response.data.orderbook || null;
  } catch (error) {
    // Silently fail for individual markets
    return null;
  }
}

// Send Discord alert
async function sendDiscordAlert(whale) {
  if (!CONFIG.DISCORD_WEBHOOK) {
    return;
  }
  
  try {
    const outcomeEmoji = whale.outcome === 'YES' ? '📈' : '📉';
    const outcomeColor = whale.outcome === 'YES' ? 0x00FF00 : 0xFF0000;
    
    const embed = {
      title: '🐋 KALSHI WHALE ALERT - LARGE ORDER',
      color: outcomeColor,
      fields: [
        { 
          name: '📊 Market', 
          value: whale.marketTitle || whale.ticker, 
          inline: false 
        },
        { 
          name: `${outcomeEmoji} Side`, 
          value: `**${whale.outcome}**`, 
          inline: true 
        },
        { 
          name: '💰 Order Size', 
          value: `**$${whale.amount.toLocaleString()}**`, 
          inline: true 
        },
        { 
          name: '💵 Price', 
          value: `${whale.price}¢`, 
          inline: true 
        },
        { 
          name: '🎯 Kalshi Link', 
          value: `**[→ View Market & Trade ←](https://kalshi.com/markets/${whale.ticker})**`, 
          inline: false 
        }
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'Kalshi Whale Tracker | Live Order Monitoring' }
    };

    await axios.post(CONFIG.DISCORD_WEBHOOK, { 
      content: `@everyone 🚨 **LARGE ORDER** detected! $${whale.amount.toLocaleString()} on ${whale.outcome}!`,
      embeds: [embed] 
    });
    
    console.log(`✅ Alert sent: $${whale.amount.toFixed(0)} ${whale.outcome} on ${whale.ticker}`);
  } catch (error) {
    console.error('❌ Discord failed:', error.message);
  }
}

// Detect large orders in orderbook
function detectLargeOrders(market, orderbook) {
  const whales = [];
  
  // Check YES side
  if (orderbook.yes && Array.isArray(orderbook.yes)) {
    for (const order of orderbook.yes) {
      const [price, quantity] = order;
      const orderValue = (price * quantity) / 100; // Convert cents to dollars
      
      if (orderValue >= CONFIG.MIN_TRADE_SIZE) {
        const alertId = `${market.ticker}-YES-${price}-${quantity}-${Date.now()}`;
        if (!seenAlerts.has(alertId)) {
          seenAlerts.add(alertId);
          whales.push({
            ticker: market.ticker,
            marketTitle: market.title,
            outcome: 'YES',
            amount: orderValue,
            price: price,
            timestamp: new Date()
          });
        }
      }
    }
  }
  
  // Check NO side
  if (orderbook.no && Array.isArray(orderbook.no)) {
    for (const order of orderbook.no) {
      const [price, quantity] = order;
      const orderValue = (price * quantity) / 100;
      
      if (orderValue >= CONFIG.MIN_TRADE_SIZE) {
        const alertId = `${market.ticker}-NO-${price}-${quantity}-${Date.now()}`;
        if (!seenAlerts.has(alertId)) {
          seenAlerts.add(alertId);
          whales.push({
            ticker: market.ticker,
            marketTitle: market.title,
            outcome: 'NO',
            amount: orderValue,
            price: price,
            timestamp: new Date()
          });
        }
      }
    }
  }
  
  return whales;
}

// Main monitoring loop
async function monitorKalshi() {
  console.log('🔍 Checking Kalshi markets...');
  
  try {
    const markets = await getActiveMarkets();
    
    if (!markets || markets.length === 0) {
      console.log('⚠️  No active markets found');
      return;
    }
    
    console.log(`📊 Found ${markets.length} active markets`);
    
    let checkedCount = 0;
    let whalesFound = 0;
    
    // Check first 30 markets
    for (const market of markets.slice(0, 30)) {
      try {
        const orderbook = await getOrderbook(market.ticker);
        
        if (orderbook) {
          const orderWhales = detectLargeOrders(market, orderbook);
          
          for (const whale of orderWhales) {
            recentWhales.unshift(whale);
            await sendDiscordAlert(whale);
            whalesFound++;
          }
          
          checkedCount++;
        }
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (err) {
        // Skip problematic markets
      }
    }
    
    // Cleanup
    if (seenAlerts.size > 500) {
      const alerts = Array.from(seenAlerts).slice(-250);
      seenAlerts.clear();
      alerts.forEach(id => seenAlerts.add(id));
    }
    
    if (recentWhales.length > 100) {
      recentWhales.splice(100);
    }
    
    console.log(`✅ Checked ${checkedCount} markets. Found ${whalesFound} whales.`);
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// API Endpoints
app.get('/api/whales', (req, res) => {
  res.json({
    whales: recentWhales,
    count: recentWhales.length
  });
});

app.get('/api/stats', (req, res) => {
  const totalVolume = recentWhales.reduce((sum, w) => sum + w.amount, 0);
  
  res.json({
    totalWhales: recentWhales.length,
    totalVolume: totalVolume,
    avgWhaleSize: recentWhales.length > 0 ? totalVolume / recentWhales.length : 0,
    lastUpdate: recentWhales[0]?.timestamp || null
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    whalesDetected: recentWhales.length
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Kalshi Whale Tracker LIVE`);
  console.log(`💰 Min order: $${CONFIG.MIN_TRADE_SIZE.toLocaleString()}`);
  console.log(`🔔 Discord: ${CONFIG.DISCORD_WEBHOOK ? 'Enabled' : 'Disabled'}`);
  console.log('');
  
  monitorKalshi();
  setInterval(monitorKalshi, CONFIG.POLL_INTERVAL);
});

process.on('SIGTERM', () => {
  console.log('Shutting down');
  process.exit(0);
});
