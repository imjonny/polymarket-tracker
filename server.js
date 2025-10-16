// server.js - Kalshi Whale Tracker
// Monitors Kalshi for large trades and volume spikes

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const CONFIG = {
  MIN_TRADE_SIZE: parseInt(process.env.MIN_TRADE_SIZE) || 15000, // $15k minimum
  VOLUME_SPIKE_THRESHOLD: parseInt(process.env.VOLUME_SPIKE_THRESHOLD) || 50000, // $50k volume spike
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK || '',
  POLL_INTERVAL: 30000, // 30 seconds
  KALSHI_API: 'https://api.elections.kalshi.com/trade-api/v2'
};

// In-memory storage
const recentWhales = [];
const marketCache = new Map(); // Store previous market states
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
    console.error('Error fetching markets:', error.message);
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
    console.error(`Error fetching orderbook for ${ticker}:`, error.message);
    return null;
  }
}

// Calculate total orderbook size
function calculateOrderbookSize(orderbook) {
  if (!orderbook) return { yesSize: 0, noSize: 0 };
  
  const yesSize = (orderbook.yes || []).reduce((sum, order) => {
    // order format: [price_in_cents, quantity]
    return sum + (order[0] * order[1] / 100); // Convert cents to dollars
  }, 0);
  
  const noSize = (orderbook.no || []).reduce((sum, order) => {
    return sum + (order[0] * order[1] / 100);
  }, 0);
  
  return { yesSize, noSize };
}

// Send Discord alert
async function sendDiscordAlert(whale) {
  if (!CONFIG.DISCORD_WEBHOOK) {
    console.log('⚠️  Discord webhook not configured');
    return;
  }
  
  try {
    const outcomeEmoji = whale.outcome === 'YES' ? '📈' : '📉';
    const outcomeColor = whale.outcome === 'YES' ? 0x00FF00 : 0xFF0000;
    const alertType = whale.type === 'large_order' ? '💰 LARGE ORDER' : '📊 VOLUME SPIKE';
    
    const embed = {
      title: `🐋 KALSHI WHALE ALERT - ${alertType}`,
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
          name: '💰 Size', 
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
      content: `@everyone 🚨 **${alertType}** detected! $${whale.amount.toLocaleString()} on ${whale.outcome}!`,
      embeds: [embed] 
    });
    
    console.log(`✅ Discord alert sent: $${whale.amount.toFixed(0)} ${whale.outcome} on ${whale.ticker}`);
  } catch (error) {
    console.error('❌ Discord alert failed:', error.message);
  }
}

// Detect large orders in orderbook
function detectLargeOrders(market, orderbook) {
  const whales = [];
  const { yesSize, noSize } = calculateOrderbookSize(orderbook);
  
  // Check YES side for large orders
  if (orderbook.yes) {
    for (const order of orderbook.yes) {
      const [price, quantity] = order;
      const orderValue = (price * quantity) / 100; // Convert to dollars
      
      if (orderValue >= CONFIG.MIN_TRADE_SIZE) {
        const alertId = `${market.ticker}-YES-${price}-${quantity}`;
        if (!seenAlerts.has(alertId)) {
          seenAlerts.add(alertId);
          whales.push({
            type: 'large_order',
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
  
  // Check NO side for large orders
  if (orderbook.no) {
    for (const order of orderbook.no) {
      const [price, quantity] = order;
      const orderValue = (price * quantity) / 100;
      
      if (orderValue >= CONFIG.MIN_TRADE_SIZE) {
        const alertId = `${market.ticker}-NO-${price}-${quantity}`;
        if (!seenAlerts.has(alertId)) {
          seenAlerts.add(alertId);
          whales.push({
            type: 'large_order',
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

// Detect volume spikes
function detectVolumeSpike(market) {
  const currentVolume = market.volume || 0;
  const previousState = marketCache.get(market.ticker);
  
  if (!previousState) {
    // First time seeing this market, just cache it
    marketCache.set(market.ticker, {
      volume: currentVolume,
      timestamp: Date.now()
    });
    return null;
  }
  
  const volumeIncrease = currentVolume - previousState.volume;
  const timeDiff = (Date.now() - previousState.timestamp) / 1000; // seconds
  
  // Update cache
  marketCache.set(market.ticker, {
    volume: currentVolume,
    timestamp: Date.now()
  });
  
  // Alert if volume increased by threshold amount
  if (volumeIncrease >= CONFIG.VOLUME_SPIKE_THRESHOLD) {
    const alertId = `${market.ticker}-volume-${currentVolume}`;
    if (!seenAlerts.has(alertId)) {
      seenAlerts.add(alertId);
      
      // Determine likely side based on price movement
      const outcome = market.yes_price > 50 ? 'YES' : 'NO';
      
      return {
        type: 'volume_spike',
        ticker: market.ticker,
        marketTitle: market.title,
        outcome: outcome,
        amount: volumeIncrease,
        price: market.yes_price || 0,
        timestamp: new Date()
      };
    }
  }
  
  return null;
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
    
    console.log(`📊 Monitoring ${markets.length} active markets`);
    
    // Debug: Show volume of top 5 markets
    const topMarkets = markets.slice(0, 5);
    console.log('Top 5 markets by listing:');
    topMarkets.forEach(m => {
      console.log(`  - ${m.ticker}: volume=${m.volume || 0}`);
    });
    
    let checkedCount = 0;
    let whalesFound = 0;
    
    // Check high-volume markets first
    const sortedMarkets = markets
      .filter(m => m.volume > 1000) // Only check markets with >$1k volume
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 50); // Check top 50 by volume
    
    for (const market of sortedMarkets) {
      try {
        // Check for volume spikes
        const volumeWhale = detectVolumeSpike(market);
        if (volumeWhale) {
          recentWhales.unshift(volumeWhale);
          await sendDiscordAlert(volumeWhale);
          whalesFound++;
        }
        
        // Check orderbook for large orders
        const orderbook = await getOrderbook(market.ticker);
        if (orderbook) {
          const orderWhales = detectLargeOrders(market, orderbook);
          for (const whale of orderWhales) {
            recentWhales.unshift(whale);
            await sendDiscordAlert(whale);
            whalesFound++;
          }
        }
        
        checkedCount++;
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (err) {
        console.error(`Error processing ${market.ticker}:`, err.message);
      }
    }
    
    // Cleanup old alerts (keep last 1000)
    if (seenAlerts.size > 1000) {
      const alerts = Array.from(seenAlerts);
      seenAlerts.clear();
      alerts.slice(-500).forEach(id => seenAlerts.add(id));
    }
    
    // Keep only last 100 whales
    if (recentWhales.length > 100) {
      recentWhales.splice(100);
    }
    
    console.log(`✅ Checked ${checkedCount} markets. Found ${whalesFound} whales.`);
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
      minTradeSize: CONFIG.MIN_TRADE_SIZE,
      volumeSpikeThreshold: CONFIG.VOLUME_SPIKE_THRESHOLD
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
    trackedMarkets: marketCache.size
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    whalesDetected: recentWhales.length,
    trackedMarkets: marketCache.size,
    mode: 'kalshi-monitoring'
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Kalshi Whale Tracker LIVE`);
  console.log(`💰 Min order size: $${CONFIG.MIN_TRADE_SIZE.toLocaleString()}`);
  console.log(`📊 Volume spike threshold: $${CONFIG.VOLUME_SPIKE_THRESHOLD.toLocaleString()}`);
  console.log(`🔔 Discord alerts: ${CONFIG.DISCORD_WEBHOOK ? '✅ Enabled' : '❌ Disabled'}`);
  console.log(`🎯 Monitoring Kalshi via public API...`);
  console.log('');
  
  // Start monitoring
  monitorKalshi();
  setInterval(monitorKalshi, CONFIG.POLL_INTERVAL);
});

process.on('SIGTERM', () => {
  console.log('👋 Shutting down');
  process.exit(0);
});
