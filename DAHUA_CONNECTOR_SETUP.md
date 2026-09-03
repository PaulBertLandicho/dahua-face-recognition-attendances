# Dahua Local Connector - Setup Guide

## Problem
Your cPanel backend (remote server) cannot reach the Dahua device on your private LAN network. The error message:
```
Dahua request timed out connecting to 192.168.111.222:80
This is a private LAN address; a cPanel server cannot reach it unless cPanel is connected to the same LAN or VPN.
```

## Solution
Use the **Local Dahua Connector** - a small Node.js service that runs on your local machine (same LAN as Dahua) and proxies requests from the remote backend.

## Architecture
```
┌─────────────────────┐
│  cPanel Backend     │  (Remote server)
│  (attendance.      │
│   multifactors...) │
└──────────┬──────────┘
           │
     HTTP Request
           │
           ▼
┌─────────────────────┐
│  Local Connector    │  (Your machine, same LAN as Dahua)
│ dahua-local-        │
│ connector.js        │
└──────────┬──────────┘
           │
     Digest Auth
           │
           ▼
┌─────────────────────┐
│  Dahua Device       │  (192.168.111.222:80)
│ DHI-ASA3213GL-MW   │
└─────────────────────┘
```

## Installation & Setup

### Step 1: Ensure Node.js is installed
```bash
node --version  # Should be v12 or higher
```

### Step 2: Install dependencies (if not already done)
```bash
npm install
```
This installs `express`, `cors`, and other required packages.

### Step 3: Run the local connector
Open a new terminal/PowerShell window and run:
```bash
node dahua-local-connector.js
```

You should see:
```
[Dahua Local Connector] Starting on port 5000
[Dahua Local Connector] Target Dahua device: 192.168.111.222:80

✓ Dahua Local Connector running on http://localhost:5000
✓ Dahua device: http://192.168.111.222:80
✓ Ready to proxy requests from cPanel backend
```

**IMPORTANT**: Keep this terminal window open! The connector must stay running.

### Step 4: Configure the backend to use the connector

#### Option A: Local Testing (if backend is also local)
Edit `.env.local`:
```env
DAHUA_CONNECTOR_URL=http://localhost:5000
```

#### Option B: Production Setup (backend is on cPanel)
You need to expose the local connector to the internet so cPanel can reach it. Use **ngrok** (recommended):

1. **Install ngrok** from https://ngrok.com/download
2. **Run ngrok** to tunnel the connector:
   ```bash
   ngrok http 5000
   ```
   You'll see output like:
   ```
   Forwarding    https://abc123.ngrok.io -> http://localhost:5000
   ```

3. **Update `.env.local`** with the ngrok URL:
   ```env
   DAHUA_CONNECTOR_URL=https://abc123.ngrok.io
   ```

4. **Restart the backend** server after updating `.env.local`

### Step 5: Test the sync
1. Go to the admin panel: https://attendance.multifactors-sales.com/admin/persons
2. Click "Sync Dahua Users" button
3. Check the console for success message

## Troubleshooting

### Connector won't start
- **Error**: `Cannot find module 'express'`
  - Solution: Run `npm install` in the workspace folder

### Still getting sync error
- Check that the connector is running: `curl http://localhost:5000/health`
- Verify `.env.local` has the correct `DAHUA_CONNECTOR_URL`
- Check connector logs for authentication issues

### ngrok URL keeps changing
- The free ngrok plan changes the URL each time you restart
- Use ngrok's stable URL feature, or run a persistent tunnel service
- Alternative: Use a VPN instead of ngrok for more reliability

### Connector works locally but fails from cPanel
- Ensure ngrok is running and the URL in `.env.local` is current
- Check firewall rules - ngrok might be blocked
- Verify the Dahua device is responding: ping/test from the connector machine

## Advanced Options

### Change connector port
Edit `dahua-local-connector.js` or set environment variable:
```bash
set DAHUA_CONNECTOR_PORT=8000
node dahua-local-connector.js
```

Then update `.env.local`:
```env
DAHUA_CONNECTOR_URL=http://localhost:8000
```

### Disable connector (revert to direct connection)
Leave `DAHUA_CONNECTOR_URL` empty in `.env.local`:
```env
DAHUA_CONNECTOR_URL=
```

The backend will use direct connection (but will fail on private LAN).

## File Structure
- `dahua-local-connector.js` - The local connector service
- `server.js` - Backend server (updated to use connector)
- `.env.local` - Configuration file (needs DAHUA_CONNECTOR_URL set)

## Support
If the connector still doesn't work:
1. Check that the Dahua device is accessible locally: `ping 192.168.111.222`
2. Verify credentials in `.env.local` match your Dahua device settings
3. Check the connector console output for error messages
4. Ensure the backend can reach the connector URL (test with curl/Postman)
