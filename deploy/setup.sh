#!/bin/bash
# ============================================
# Oracle Cloud Free Tier 一鍵部署腳本
# 在 VM 上執行：bash setup.sh
# ============================================
set -e

APP_DIR="/opt/quiz-app"
DATA_DIR="/data"

echo "=== 1. 更新系統 ==="
sudo apt update && sudo apt upgrade -y

echo "=== 2. 安裝 Node.js 20 LTS ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

echo "=== 3. 安裝 Nginx ==="
sudo apt install -y nginx

echo "=== 4. 安裝 PM2 ==="
sudo npm install -g pm2

echo "=== 5. 建立資料目錄 ==="
sudo mkdir -p $DATA_DIR/uploads
sudo chown -R $USER:$USER $DATA_DIR

echo "=== 6. 建立應用目錄 ==="
sudo mkdir -p $APP_DIR
sudo chown -R $USER:$USER $APP_DIR

echo "=== 7. 複製應用程式 ==="
# 如果是從 git clone，跳過這步
if [ -f "./app.js" ]; then
  cp -r ./*.js ./*.json ./public $APP_DIR/
fi

echo "=== 8. 安裝依賴 ==="
cd $APP_DIR
npm install --production

echo "=== 9. 設定環境變數 ==="
cat > $APP_DIR/.env << 'ENVEOF'
NODE_ENV=production
PORT=3000
DB_PATH=/data/quiz.db
UPLOADS_DIR=/data/uploads
SESSION_SECRET=$(openssl rand -base64 32)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
ENVEOF
# 產生真正的隨機 session secret
sed -i "s|\$(openssl rand -base64 32)|$(openssl rand -base64 32)|" $APP_DIR/.env

echo ""
echo "⚠️  請編輯 $APP_DIR/.env 修改管理員密碼！"
echo "    nano $APP_DIR/.env"
echo ""

echo "=== 10. 用 PM2 啟動應用 ==="
cd $APP_DIR
pm2 start app.js --name quiz --env-file .env
pm2 save
pm2 startup | tail -1 | bash

echo "=== 11. 設定 Nginx 反向代理 ==="
sudo tee /etc/nginx/sites-available/quiz << 'NGINXEOF'
server {
    listen 80;
    server_name _;

    client_max_body_size 20M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINXEOF

sudo ln -sf /etc/nginx/sites-available/quiz /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx
sudo systemctl enable nginx

echo "=== 12. 開啟 OS 防火牆 ==="
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || true

echo "=== 13. 設定每日自動備份 ==="
mkdir -p /home/$USER/backups
cat > /home/$USER/backup.sh << 'BACKUPEOF'
#!/bin/bash
BACKUP_DIR="/home/$USER/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR
cp /data/quiz.db "$BACKUP_DIR/quiz_${TIMESTAMP}.db"
tar czf "$BACKUP_DIR/uploads_${TIMESTAMP}.tar.gz" -C /data uploads/ 2>/dev/null
find $BACKUP_DIR -mtime +7 -delete
BACKUPEOF
chmod +x /home/$USER/backup.sh
(crontab -l 2>/dev/null; echo "0 3 * * * /home/$USER/backup.sh") | sort -u | crontab -

echo ""
echo "============================================"
echo "  ✅ 部署完成！"
echo "============================================"
echo ""
echo "  🌐 網站：http://$(curl -s ifconfig.me)"
echo "  🔧 後台：http://$(curl -s ifconfig.me)/admin"
echo "  📁 資料：$DATA_DIR"
echo "  📋 日誌：pm2 logs quiz"
echo ""
echo "  ⚠️  記得修改管理員密碼："
echo "     nano $APP_DIR/.env"
echo "     pm2 restart quiz"
echo ""
