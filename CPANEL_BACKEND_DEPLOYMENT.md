# cPanel Backend Deployment & Storage Optimization Guide

## 1. Storage-Optimized Backend Deployment

> [!IMPORTANT]
> **DO NOT** upload the root `package.json` to cPanel! The root package file contains React, Babel, and Craco dev tools, which downloads **1.34 GB (46,755 files)** into `node_modules` and consumes your entire cPanel inode quota.
>
> Instead, use the dedicated **`cpanel-backend/package.json`** created for cPanel, which installs only **~25 MB (< 1,000 files)**.

---

### Step 1: Prepare Backend Files on cPanel

1. In cPanel **File Manager**, navigate to `/public_html`.
2. Create folder: `api` (full path: `/public_html/api`).
3. Upload **ONLY** these 3 files into `/public_html/api`:
   * `server.js` (from project root)
   * `package.json` (**Use the file from `cpanel-backend/package.json`**, rename to `package.json` if needed)
   * `.env.local`

---

### Step 2: Configure `.env.local` for cPanel

In `/public_html/api/.env.local`, set:

```env
# Database (localhost because backend and MySQL are on the same cPanel server)
DB_HOST=localhost
DB_PORT=3306
DB_USER=multifac_admin
DB_PASSWORD=multifactorsattendance
DB_NAME=multifac_attendance

# Photo Retention (Days to keep daily punch snapshots in MySQL before auto-pruning)
PHOTO_RETENTION_DAYS=60

# Live stream: set to false on cPanel (Dahua camera operates locally on office LAN)
ENABLE_LIVE_STREAM=false
```

---

### Step 3: Install Lightweight Dependencies on cPanel

SSH into cPanel or use cPanel Terminal:
```bash
cd ~/public_html/api
npm install --omit=dev --no-audit --no-fund
```
*Result: Installs in seconds, consumes only ~25 MB instead of 1.34 GB, and uses less than 1,000 inodes!*

---

### Step 4: Setup Node.js on cPanel (Setup Node.js App)

1. In cPanel, open **Setup Node.js App** (Phusion Passenger).
2. Click **Create Application**.
3. Fill in:
   * **Node.js version**: 18.x or 20.x
   * **Application mode**: Production
   * **Application root**: `public_html/api`
   * **Application URL**: `attendance.multifactors-sales.com/api` (or your domain/api)
   * **Application startup file**: `server.js`
4. Click **Create** / **Start App**.

---

## 2. Server Hygiene & Freeing Existing cPanel Storage

If your cPanel account was already showing high disk usage or running out of inodes, run these cleanup steps in cPanel File Manager or Terminal:

### 1. Empty cPanel File Manager Trash (`.trash`)
When you delete files via cPanel File Manager, they are moved to a hidden trash folder and **still consume your disk quota**:
```bash
rm -rf ~/.trash/*
```
*(Or in cPanel File Manager, click **"View Trash"** at the top and click **"Empty Trash"**).*

### 2. Purge npm Cache
Running `npm install` creates hidden cache archives in your home directory:
```bash
npm cache clean --force
rm -rf ~/.npm
```

### 3. Clear Stale Passenger & Apache Error Logs
If `stderr.log` or `error_log` has grown large:
```bash
# Truncate Passenger logs
> ~/public_html/api/stderr.log
# Find and truncate any error_log files larger than 20MB
find ~/public_html -name "error_log" -size +20M -exec truncate -s 0 {} \;
```

---

## 3. Database Maintenance & Photo Retention

Your backend server now includes **automatic 60-day photo retention**:
* **Every 24 hours**, `server.js` automatically runs:
  ```sql
  UPDATE attendance 
  SET photo = NULL 
  WHERE photo IS NOT NULL 
    AND device_time < DATE_SUB(NOW(), INTERVAL 60 DAY);
  ```
  *All employee timestamps, hours, overtime, and payroll records are kept permanently.*
  *Only the heavy 500 KB Base64 daily punch snapshots are pruned.*

### Manual Storage & Prune Endpoints

You can also trigger or inspect storage at any time via API or browser:

* **Check Storage Stats**:
  ```bash
  curl https://attendance.multifactors-sales.com/api/api/maintenance/storage-stats
  ```
  Returns:
  ```json
  {
    "totalAttendanceRecords": 4520,
    "recordsWithPhotos": 120,
    "photosOlderThanRetention": 0,
    "retentionDaysConfigured": 60
  }
  ```

* **Manually Prune Old Photos (e.g., older than 60 days)**:
  ```bash
  curl -X POST https://attendance.multifactors-sales.com/api/api/maintenance/prune-photos
  ```

* **Reclaim Free Space in MySQL (OPTIMIZE TABLE)**:
  ```bash
  curl -X POST https://attendance.multifactors-sales.com/api/api/maintenance/optimize-tables
  ```

---

## 4. Frontend Deployment (Static Files Only)

**Never** run `npm install` for the React frontend on cPanel. Build locally and upload only the static files:

1. On your local machine:
   ```bash
   npm run build
   ```
   *(With `.env.production` having `GENERATE_SOURCEMAP=false`, this produces a clean ~15 MB production bundle without heavy `.map` files).*
2. Upload the **contents** of your local `build/` folder directly to `/public_html` (so `index.html` sits directly inside `/public_html/index.html`).
