# MySQL Connection Troubleshooting Guide

## Current Status
- ✅ Backend Server: Running on http://localhost:4000
- ✅ Dahua Connector: Running on http://localhost:5000  
- ❌ Database Connection: Needs correct hostname

## Problem
The MySQL hostname needs to be found from your cPanel hosting provider.

## How to Find Your MySQL Hostname

### Option 1: Check cPanel Database Connection String (Recommended)
1. Login to your cPanel: https://your-cpanel-domain:2083
2. Find **"Databases"** section → **"MySQL Databases"** or **"Remote MySQL"**
3. Look for a **"Connection String"** or **"Host Information"** field
4. It will show something like:
   - `localhost`
   - `mysql.yourdomain.com`
   - An IP address like `123.45.67.89`

### Option 2: Check Your Hosting Documentation
- Your hosting provider sent you setup docs
- Search for "MySQL hostname" or "database host"
- Look for terms like "remote access" or "connection details"

### Option 3: Check Database Connection History
- If you've connected before (phpMyAdmin), the hostname might be in browser history
- Check your previous working configurations

### Option 4: Contact Your Hosting Provider
- Email support with: "What is the MySQL hostname for remote connections?"
- They'll provide the exact hostname

## Common Hostnames by Provider

| Hostname Format | When to Use |
|---|---|
| `localhost` | Only if app is ON the same cPanel server |
| `127.0.0.1` | Same as localhost (local only) |
| `yourdomain.com` | For remote access from your domain |
| `mysql.yourdomain.com` | Common cPanel MySQL subdomain |
| `your-server.hosting-provider.com` | Provider's standard format |
| IP address (xxx.xxx.xxx.xxx) | Direct server IP access |

## Current Configuration

**File:** `.env.local`

```env
DB_HOST=multifactors-sales.com    ← UPDATE THIS
DB_PORT=3306
DB_USER=multifac_admin
DB_PASSWORD=multifactorsattendance
DB_NAME=multifac_attendance
```

## How to Update

1. Find the correct hostname from your cPanel
2. Edit `.env.local` and update `DB_HOST=`
3. Restart the backend server:
   ```bash
   node server.js
   ```

## Test the Connection

Once you update the hostname:

```bash
# The server should connect without "Database login failed" errors
node server.js

# Test login endpoint
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test"}'
```

## Error Messages & Solutions

### "ECONNREFUSED" or "Connection refused"
- MySQL service is not running
- Hostname is wrong (can't reach that server)
- Port 3306 is blocked by firewall

### "ENOTFOUND"
- Hostname doesn't exist or isn't resolving
- DNS issue - wrong hostname format
- Check spelling carefully

### "Access denied for user"
- Hostname is correct but credentials are wrong
- Verify DB_USER and DB_PASSWORD in `.env.local`

### "Unknown database"
- Hostname is correct, credentials work, but DB_NAME is wrong
- Check if the database name is exactly `multifac_attendance`

## Next Steps

1. **Find your MySQL hostname** from cPanel
2. **Update `.env.local`** with the correct hostname
3. **Restart the server** to apply changes
4. **Test the sync** in the admin dashboard

Once this is fixed, you can test:
- ✅ Dahua user sync
- ✅ Attendance record sync
- ✅ Full application functionality
