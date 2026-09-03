# Fix MySQL Connection Error - Complete Setup Guide

## Current Error
```
Dahua user sync failed: MySQL connection was refused. 
Check DB_HOST, DB_PORT, and that the MySQL service is running.
```

## Root Cause
The backend server cannot connect to MySQL. This happens when:
1. ❌ MySQL service is down on cPanel
2. ❌ Wrong database credentials (DB_USER, DB_PASSWORD, DB_NAME)
3. ❌ Wrong database host (DB_HOST)
4. ❌ MySQL not accessible from backend location

---

## Solution: Deploy Backend to cPanel

Since your frontend is already on cPanel, the **easiest solution** is to deploy the backend to cPanel as well. Then it can use `localhost` for MySQL without any remote access configuration.

### Step 1: Prepare Backend Files

Create a new directory on cPanel for the backend:

1. **Via cPanel File Manager:**
   - Go to cPanel → File Manager
   - Navigate to `/public_html`
   - Create folder: `api` (so path is `/public_html/api`)
   - Upload these files:
     - `server.js`
     - `dahua-local-connector.js`
     - `package.json`
     - `.env.local`

2. **Or via SSH:**
   ```bash
   ssh your-cpanel-user@city-control-panel.com
   cd public_html
   mkdir api
   cd api
   # Upload files here
   ```

### Step 2: Update `.env.local` for cPanel

In the `.env.local` file on cPanel, change:

**FROM:**
```env
DB_HOST=attendance.multifactors-sales.com
```

**TO:**
```env
DB_HOST=localhost
```

This works because the backend is now ON the same cPanel server as MySQL.

### Step 3: Install Dependencies on cPanel

SSH into cPanel:
```bash
ssh your-cpanel-user@city-control-panel.com
cd public_html/api
npm install
```

### Step 4: Setup Node.js on cPanel

cPanel needs to run Node.js. Use **Phusion Passenger** (usually pre-installed):

1. Go to cPanel → **Ruby/Node.js Apps** (or **Phusion Passenger**)
2. Click **"Create Application"**
3. Set:
   - **Node.js version:** 18.x or higher
   - **Application root:** `/public_html/api`
   - **Startup file:** `server.js`
   - **Application URL:** `https://attendance.multifactors-sales.com/api`
4. Click **Deploy** or **Create**

### Step 5: Test the Connection

Once deployed, test:
```bash
curl https://attendance.multifactors-sales.com/api/api/dahua/sync-users
```

You should get a response (not a connection error).

---

## Alternative: Quick Fix Without Deployment

If you can't deploy to cPanel right now, try these troubleshooting steps:

### 1. Check MySQL Service on cPanel

**SSH into cPanel:**
```bash
ssh your-cpanel-user@city-control-panel.com
systemctl status mysql
# or
service mysql status
```

**If stopped, start it:**
```bash
sudo systemctl start mysql
# or
sudo service mysql start
```

### 2. Verify Database & User Exist

```bash
mysql -u multifac_admin -p
# Enter password: multifactorsattendance

# Check database
SHOW DATABASES;
# You should see: multifac_attendance

# Check tables
USE multifac_attendance;
SHOW TABLES;
```

### 3. Fix .env.local on cPanel

Make sure `/public_html/.env.local` has:
```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=multifac_admin
DB_PASSWORD=multifactorsattendance
DB_NAME=multifac_attendance
```

### 4. Restart the Backend

If backend is running via Phusion Passenger:
- cPanel → Ruby/Node.js Apps → Restart

---

## Files to Upload to cPanel

```
/public_html/api/
├── server.js
├── dahua-local-connector.js
├── package.json
├── .env.local
└── node_modules/  (created after npm install)
```

## Updated .env.local for cPanel

```env
# Database (localhost because backend is on cPanel)
DB_HOST=localhost
DB_PORT=3306
DB_USER=multifac_admin
DB_PASSWORD=multifactorsattendance
DB_NAME=multifac_attendance

# API URLs
REACT_APP_BACKEND_URL=https://attendance.multifactors-sales.com/api

# Dahua Connector (keep local if running on same machine)
DAHUA_CONNECTOR_URL=http://localhost:5000

# (Keep all other Supabase keys as they are)
```

---

## Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| "Connection refused" | MySQL service not running - start it |
| "Access denied" | Wrong credentials - verify username/password |
| "Unknown database" | Database not created - create `multifac_attendance` |
| "Can't connect to host" | Backend not deployed to cPanel yet |
| Dahua connector fails | Make sure dahua-local-connector.js is running locally on port 5000 |

---

## Summary

**Best Approach:**
1. Deploy backend to cPanel ✅
2. Use `localhost` for DB_HOST ✅
3. MySQL runs on same server ✅
4. No remote access issues ✅
5. Dahua connector still runs locally ✅

This way:
- Frontend (cPanel) → Backend (cPanel) → MySQL (cPanel) = ✅ Works
- Backend (local) → Dahua Connector (local) → Dahua Device (local) = ✅ Works

Would you like me to help with any specific step?
