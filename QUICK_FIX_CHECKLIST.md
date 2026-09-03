# Quick Fix Checklist

## Immediate Actions (Choose One Path)

### ✅ PATH 1: Deploy Backend to cPanel (Recommended)
- [ ] Create `/public_html/api` folder on cPanel
- [ ] Upload: `server.js`, `package.json`, `.env.local`
- [ ] Update `.env.local`: Change `DB_HOST=localhost`
- [ ] SSH into cPanel and run: `npm install`
- [ ] Setup Phusion Passenger/Node.js app in cPanel
- [ ] Set startup file: `server.js`
- [ ] Test: `curl https://attendance.multifactors-sales.com/api/health`

### ⚡ PATH 2: Quick Fix (If already deployed)
- [ ] SSH into cPanel
- [ ] Check MySQL is running: `systemctl status mysql`
- [ ] If stopped: `sudo systemctl start mysql`
- [ ] Verify `.env.local` has correct credentials
- [ ] Restart backend app
- [ ] Test the sync button again

### 📝 PATH 3: For Testing Locally First
- [ ] Keep backend running on `http://localhost:4000`
- [ ] Keep Dahua connector running on `http://localhost:5000`
- [ ] Update `.env.local`: Use `localhost` for DB_HOST
- [ ] Test locally before deploying to cPanel

---

## Your Current Setup

**Local Machine:**
- ✅ Backend: `http://localhost:4000`
- ✅ Dahua Connector: `http://localhost:5000`
- ⚠️ MySQL: Trying to connect to cPanel (failing)

**Better Setup:**
- Backend: On cPanel server
- MySQL: On cPanel server (localhost)
- Dahua Connector: Keep on local machine

---

## Key .env.local Changes

### For cPanel Deployment:
```env
DB_HOST=localhost              ← Change this
DB_PORT=3306
DB_USER=multifac_admin
DB_PASSWORD=multifactorsattendance
DB_NAME=multifac_attendance
```

### For Local Testing:
```env
DB_HOST=localhost              ← Use this
DB_PORT=3306
DB_USER=multifac_admin
DB_PASSWORD=multifactorsattendance
DB_NAME=multifac_attendance
DAHUA_CONNECTOR_URL=http://localhost:5000
```

---

## Next Step: What Should I Do?

**Option A:** I'll help you deploy to cPanel (recommended)
**Option B:** I'll help you fix the local MySQL connection
**Option C:** I'll create a SQLite backup for local testing

Which would you prefer?
