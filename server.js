import requests
import time
from datetime import datetime
from typing import Dict, List, Set
import hashlib

class KalshiWhaleTracker:
    """
    Monitors Kalshi for large orders and sends Discord alerts.
    Fixed to prevent duplicate alerts.
    """
    
    def __init__(self, discord_webhook_url: str, order_threshold: float = 10000):
        self.discord_webhook = discord_webhook_url
        self.order_threshold = order_threshold
        self.kalshi_api_base = "https://api.elections.kalshi.com/trade-api/v2"
        
        # Track seen orders using a unique hash
        self.seen_orders: Set[str] = set()
        
        # Track the last timestamp we checked to avoid re-processing old data
        self.last_check_time = datetime.utcnow()
    
    def create_order_hash(self, order: Dict) -> str:
        """
        Create a unique hash for an order to prevent duplicates.
        Uses: ticker + side + price + size + timestamp
        """
        # Extract key fields
        ticker = order.get('ticker', '')
        side = order.get('side', '')
        price = order.get('yes_price', order.get('no_price', 0))
        size = order.get('count', 0)
        
        # Create a unique string
        unique_string = f"{ticker}_{side}_{price}_{size}"
        
        # Return hash
        return hashlib.md5(unique_string.encode()).hexdigest()
    
    def get_active_markets(self) -> List[Dict]:
        """
        Fetch all active markets from Kalshi
        """
        try:
            response = requests.get(
                f"{self.kalshi_api_base}/markets",
                params={
                    "status": "open",
                    "limit": 100
                }
            )
            
            if response.status_code == 200:
                data = response.json()
                return data.get('markets', [])
            else:
                print(f"❌ Failed to fetch markets: {response.status_code}")
                return []
                
        except Exception as e:
            print(f"❌ Error fetching markets: {e}")
            return []
    
    def get_market_orderbook(self, ticker: str) -> Dict:
        """
        Get the current orderbook for a specific market
        """
        try:
            response = requests.get(
                f"{self.kalshi_api_base}/markets/{ticker}/orderbook"
            )
            
            if response.status_code == 200:
                return response.json()
            else:
                return {}
                
        except Exception as e:
            print(f"⚠️ Error fetching orderbook for {ticker}: {e}")
            return {}
    
    def find_large_orders(self, orderbook: Dict, ticker: str, market_title: str) -> List[Dict]:
        """
        Find orders above the threshold in the orderbook
        """
        large_orders = []
        
        # Check Yes orders
        yes_orders = orderbook.get('yes', [])
        for order in yes_orders:
            count = order.get('count', 0)
            price = order.get('price', 0)
            value = (count * price) / 100  # Convert from cents
            
            if value >= self.order_threshold:
                order_hash = self.create_order_hash({
                    'ticker': ticker,
                    'side': 'yes',
                    'yes_price': price,
                    'count': count
                })
                
                # Only add if we haven't seen this order before
                if order_hash not in self.seen_orders:
                    large_orders.append({
                        'ticker': ticker,
                        'market_title': market_title,
                        'side': 'YES',
                        'price': price,
                        'count': count,
                        'value': value,
                        'hash': order_hash
                    })
                    self.seen_orders.add(order_hash)
        
        # Check No orders
        no_orders = orderbook.get('no', [])
        for order in no_orders:
            count = order.get('count', 0)
            price = order.get('price', 0)
            value = (count * price) / 100  # Convert from cents
            
            if value >= self.order_threshold:
                order_hash = self.create_order_hash({
                    'ticker': ticker,
                    'side': 'no',
                    'no_price': price,
                    'count': count
                })
                
                # Only add if we haven't seen this order before
                if order_hash not in self.seen_orders:
                    large_orders.append({
                        'ticker': ticker,
                        'market_title': market_title,
                        'side': 'NO',
                        'price': price,
                        'count': count,
                        'value': value,
                        'hash': order_hash
                    })
                    self.seen_orders.add(order_hash)
        
        return large_orders
    
    def send_discord_alert(self, order: Dict):
        """
        Send a single alert to Discord
        """
        try:
            market_url = f"https://kalshi.com/markets/{order['ticker']}"
            
            embed = {
                "title": "🐋 KALSHI WHALE ALERT - LARGE ORDER",
                "color": 15158332,  # Red
                "fields": [
                    {
                        "name": "📊 Market",
                        "value": order['market_title'],
                        "inline": False
                    },
                    {
                        "name": "🔵 Side",
                        "value": order['side'],
                        "inline": True
                    },
                    {
                        "name": "💰 Order Size",
                        "value": f"${order['value']:,.2f}",
                        "inline": True
                    },
                    {
                        "name": "📈 Price",
                        "value": f"{order['price']}¢",
                        "inline": True
                    },
                    {
                        "name": "🔗 Kalshi Link",
                        "value": f"[→ View Market & Trade ←]({market_url})",
                        "inline": False
                    }
                ],
                "footer": {
                    "text": f"Kalshi Whale Tracker | Live Order Monitoring"
                },
                "timestamp": datetime.utcnow().isoformat()
            }
            
            payload = {
                "content": f"@everyone 🚨 **LARGE ORDER** detected! ${order['value']:,.0f} on {order['side']}!",
                "embeds": [embed],
                "username": "Kalshi Whale Tracker"
            }
            
            response = requests.post(self.discord_webhook, json=payload)
            
            if response.status_code == 204:
                print(f"✅ Alert sent for {order['ticker']} - ${order['value']:,.0f} on {order['side']}")
            else:
                print(f"❌ Discord webhook failed: {response.status_code}")
                
        except Exception as e:
            print(f"❌ Error sending Discord alert: {e}")
    
    def cleanup_old_hashes(self):
        """
        Periodically clean up old order hashes to prevent memory issues.
        Keep only the most recent 10,000 hashes.
        """
        if len(self.seen_orders) > 10000:
            # Convert to list, keep last 5000
            recent_orders = list(self.seen_orders)[-5000:]
            self.seen_orders = set(recent_orders)
            print(f"🧹 Cleaned up old order hashes. Now tracking {len(self.seen_orders)} orders.")
    
    def run(self, interval: int = 30):
        """
        Main bot loop - checks markets periodically
        """
        print("🤖 Kalshi Whale Tracker Starting...")
        print(f"💰 Tracking orders over ${self.order_threshold:,.0f}")
        print(f"⏱️  Checking every {interval} seconds")
        print("🔄 Duplicate detection enabled")
        print("=" * 60)
        
        check_count = 0
        
        while True:
            try:
                check_count += 1
                current_time = datetime.utcnow()
                print(f"\n[{current_time.strftime('%Y-%m-%d %H:%M:%S')}] Check #{check_count}")
                
                # Get all active markets
                markets = self.get_active_markets()
                
                if not markets:
                    print("⚠️ No markets retrieved, will retry...")
                    time.sleep(interval)
                    continue
                
                print(f"📊 Monitoring {len(markets)} active markets...")
                
                new_alerts = 0
                
                # Check each market's orderbook
                for market in markets:
                    ticker = market.get('ticker', '')
                    title = market.get('title', 'Unknown Market')
                    
                    # Get orderbook
                    orderbook = self.get_market_orderbook(ticker)
                    
                    if orderbook:
                        # Find large orders
                        large_orders = self.find_large_orders(orderbook, ticker, title)
                        
                        # Send alerts for new large orders
                        for order in large_orders:
                            self.send_discord_alert(order)
                            new_alerts += 1
                            time.sleep(1)  # Rate limit Discord webhooks
                    
                    # Small delay between API calls
                    time.sleep(0.2)
                
                if new_alerts > 0:
                    print(f"🐋 Sent {new_alerts} new whale alert(s)")
                else:
                    print("💤 No new large orders detected")
                
                # Cleanup old hashes periodically (every 100 checks)
                if check_count % 100 == 0:
                    self.cleanup_old_hashes()
                
                # Update last check time
                self.last_check_time = current_time
                
                # Wait before next check
                print(f"⏳ Waiting {interval} seconds until next check...")
                time.sleep(interval)
                
            except KeyboardInterrupt:
                print("\n\n👋 Bot stopped by user")
                print(f"📊 Final stats: Tracked {len(self.seen_orders)} unique orders")
                break
                
            except Exception as e:
                print(f"❌ Error in main loop: {e}")
                print("⏳ Waiting before retry...")
                time.sleep(interval)


# Example usage
if __name__ == "__main__":
    # Configuration
    DISCORD_WEBHOOK_URL = "YOUR_DISCORD_WEBHOOK_URL_HERE"
    ORDER_THRESHOLD = 10000  # Alert for orders over $10k
    CHECK_INTERVAL = 30  # Check every 30 seconds
    
    # Initialize and run bot
    bot = KalshiWhaleTracker(
        discord_webhook_url=DISCORD_WEBHOOK_URL,
        order_threshold=ORDER_THRESHOLD
    )
    
    bot.run(interval=CHECK_INTERVAL)
