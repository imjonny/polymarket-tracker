// server.js - Kalshi Whale Tracker
// Monitors Kalshi for large trades - NO DUPLICATE ALERTS

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const CONFIG = {
  MIN_TRADE_SIZE: parseInt(process.env.MIN_TRADE_SIZE) || 15000,
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK || '',
  POLL_INTERVAL: 30000, // 30 seconds
  KALSHI_API: 'https://api.elections.kalshi.com/trade-api/v2'
};

// In-memory storage
const recentWhales = [];
const seenAlerts = new Set(); // Track which orders we've already alerted on

// Create unique hash for each order to prevent duplicates
function createOrderHash(ticker, side, price, count) {
  return `${ticker}_${side}_${price}_${count}`;
}

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
    
    return response.data || null;
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
    const outcomeColor = whale.outcome === 'YES' ? 3066993 : 15158332;
    const marketUrl = `https://kalshi.com/markets/${whale.ticker}`;
    
    const embed = {
      title: `🐋 KALSHI WHALE ALERT - LARGE ORDER`,
      description: `@everyone 🚨 **LARGE ORDER** detected! $${whale.amount.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})} on ${whale.outcome}!`,
      color: outcomeColor,
      fields: [
        {
          name: '📊 Market',
          value: whale.market,
          inline: false
        },
        {
          name: `${outcomeEmoji} Side`,
          value: whale.outcome,
          inline: true
        },
        {
          name: '💰 Order Size',
          value: `$${whale.amount.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`,
          inline: true
        },
        {
          name: '📈 Price',
          value: `${whale.price}¢`,
          inline: true
        },
        {
          name: '🔗 Kalshi Link',
          value: `[→ View Market & Trade ←](${marketUrl})`,
          inline: false
        }
      ],
      footer: {
        text: 'Kalshi Whale Tracker | Live Order Monitoring'
      },
      timestamp: new Date().toISOString()
    };
    
    const payload = {
      embeds: [embed],
      username: 'Kalshi Whale Tracker'
    };
    
    const response = await axios.post(CONFIG.DISCORD_WEBHOOK, payload);
    
    if (response.status === 204) {
      console.log(`✅ Alert sent: ${whale.market.substring(0, 50)}... - $${whale.amount.toFixed(2)} ${whale.outcome}`);
    }
  } catch (error) {
    console.error('❌ Discord webhook error:', error.message);
  }
}

// Check orderbook for large orders
async function checkForLargeOrders(ticker, title) {
  const orderbook = await getOrderbook(ticker);
  if (!orderbook || !orderbook.yes || !orderbook.no) return [];

  const whales = [];

  // Check YES orders
  for (const order of orderbook.yes || []) {
    const count = order.count || 0;
    const price = order.price || 0;
    const orderValue = (count * price) / 100;

    if (orderValue >= CONFIG.MIN_TRADE_SIZE) {
      const hash = createOrderHash(ticker, 'YES', price, count);
      
      // Only alert if we haven't seen this exact order before
      if (!seenAlerts.has(hash)) {
        seenAlerts.add(hash);
        
        const whale = {
          ticker,
          market: title,
          outcome: 'YES',
          amount: orderValue,
          price: price,
          count: count,
          timestamp: new Date().toISOString(),
          type: 'large_order'
        };
        
        whales.push(whale);
        recentWhales.unshift(whale);
        if (recentWhales.length > 100) recentWhales.pop();
        
        await sendDiscordAlert(whale);
      }
    }
  }

  // Check NO orders
  for (const order of orderbook.no || []) {
    const count = order.count || 0;
    const price = order.price || 0;
    const orderValue = (count * price) / 100;

    if (orderValue >= CONFIG.MIN_TRADE_SIZE) {
      const hash = createOrderHash(ticker, 'NO', price, count);
      
      // Only alert if we haven't seen this exact order before
      if (!seenAlerts.has(hash)) {
        seenAlerts.add(hash);
        
        const whale = {
          ticker,
          market: title,
          outcome: 'NO',
          amount: orderValue,
          price: price,
          count: count,
          timestamp: new Date().toISOString(),
          type: 'large_order'
        };
        
        whales.push(whale);
        recentWhales.unshift(whale);
        if (recentWhales.length > 100) recentWhales.pop();
        
        await sendDiscordAlert(whale);
      }
    }
  }

  return whales;
}

// Main monitoring function
async function monitorKalshi() {
  try {
    console.log(`\n[${new Date().toLocaleTimeString()}] 🔍 Scanning Kalshi...`);
    
    const markets = await getActiveMarkets();
    
    if (markets.length === 0) {
      console.log('⚠️ No active markets found');
      return;
    }

    console.log(`📊 Checking ${markets.length} active markets...`);
    
    let whalesFound = 0;
    
    for (const market of markets) {
      const ticker = market.ticker;
      const title = market.title || 'Unknown Market';
      
      const whales = await checkForLargeOrders(ticker, title);
      whalesFound += whales.length;
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    if (whalesFound > 0) {
      console.log(`🐋 Found ${whalesFound} NEW whale alert(s)`);
    } else {
      console.log('💤 No new large orders detected');
    }
    
    // Cleanup old hashes every 100 checks to prevent memory issues
    if (seenAlerts.size > 5000) {
      const alertsArray = Array.from(seenAlerts);
      seenAlerts.clear();
      // Keep most recent 2500 hashes
      alertsArray.slice(-2500).forEach(hash => seenAlerts.add(hash));
      console.log('🧹 Cleaned up old order hashes');
    }
    
  } catch (error) {
    console.error('❌ Monitoring error:', error.message);
  }
}

// API Endpoints
app.get('/api/whales', (req, res) => {
  res.json({
    whales: recentWhales,
    count: recentWhales.length,
    config: {
      minTradeSize: CONFIG.MIN_TRADE_SIZE
    }
  });
});

app.get('/api/stats', (req, res) => {
  const totalVolume = recentWhales.reduce((sum, w) => sum + w.amount, 0);
  const avgWhaleSize = recentWhales.length > 0 ? totalVolume / recentWhales.length : 0;
  
  res.json({
    totalWhales: recentWhales.length,
    totalVolume: totalVolume,
    avgWhaleSize: avgWhaleSize,
    lastUpdate: recentWhales[0]?.timestamp || null,
    uniqueOrdersTracked: seenAlerts.size
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    whalesDetected: recentWhales.length,
    uniqueOrdersTracked: seenAlerts.size,
    mode: 'kalshi-monitoring'
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Kalshi Whale Tracker LIVE`);
  console.log(`💰 Min order size: $${CONFIG.MIN_TRADE_SIZE.toLocaleString()}`);
  console.log(`🔔 Discord alerts: ${CONFIG.DISCORD_WEBHOOK ? '✅ Enabled' : '❌ Disabled'}`);
  console.log(`🔄 Duplicate prevention: ✅ Enabled`);
  console.log(`🎯 Monitoring Kalshi via public API...`);
  console.log('');
  
  // Start monitoring
  monitorKalshi();
  setInterval(monitorKalshi, CONFIG.POLL_INTERVAL);
});

process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully');
  console.log(`📊 Final stats: ${recentWhales.length} whales tracked, ${seenAlerts.size} unique orders seen`);
  process.exit(0);
});
