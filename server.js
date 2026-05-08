require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Pool } = require('pg');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');

const app = express();
app.use(cors());
app.use(express.json()); // Allows Express to read JSON body

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ==========================================
// 1. DATABASE CONNECTION (PostgreSQL)
// ==========================================
const db = new Pool({
    connectionString: process.env.DATABASE_URL, // e.g. postgres://user:pass@host:5432/dbname
    ssl: { rejectUnauthorized: false } // Required for cloud databases like Railway/Heroku
});

// ==========================================
// 2. AWS S3 SETUP (For Images/Videos)
// ==========================================
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY,
        secretAccessKey: process.env.AWS_SECRET_KEY
    }
});

const uploadToS3 = multer({
    storage: multerS3({
        s3: s3,
        bucket: process.env.AWS_BUCKET_NAME,
        acl: 'public-read',
        key: function (req, file, cb) {
            cb(null, `uploads/${Date.now()}_${file.originalname}`);
        }
    })
});

// ==========================================
// 3. JWT SECURITY MIDDLEWARE (The Bouncer)
// ==========================================
function verifyToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ success: false, message: "Access Denied: No Token" });

    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ success: false, message: "Invalid or Expired Token" });
        req.user = user; // Attach user info to the request
        next();
    });
}

function requireRole(role) {
    return (req, res, next) => {
        if (req.user.role !== role && req.user.role !== 'super_admin') {
            return res.status(403).json({ success: false, message: "Forbidden: You do not have permission." });
        }
        next();
    }
}

// ==========================================
// 4. AUTHENTICATION ENDPOINTS
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    const { firstName, lastName, email, password, role } = req.body;

    // 🚨 STRICT SECURITY BLOCK FOR SUPER ADMIN 🚨
    if (role === 'super_admin') {
        return res.status(403).json({ success: false, message: "Unauthorized attempt to create Super Admin." });
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const result = await db.query(
            `INSERT INTO users (first_name, last_name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, role`,
            [firstName, lastName, email, hashedPassword, role]
        );

        res.status(201).json({ success: true, message: "Account created" });
    } catch (err) {
        if(err.code === '23505') return res.status(400).json({ success: false, message: "Email already exists" });
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const result = await db.query(`SELECT * FROM users WHERE email = $1`, [email]);
        if (result.rows.length === 0) return res.status(400).json({ success: false, message: "Invalid email" });

        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) return res.status(400).json({ success: false, message: "Invalid password" });

        // Generate JWT Token (Valid for 24 hours)
        const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });

        res.json({ success: true, token, user: { id: user.id, role: user.role, firstName: user.first_name }});
    } catch (err) {
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ==========================================
// 5. PLAYER UPLOAD ENDPOINT (Images to S3)
// ==========================================
app.post('/api/players', verifyToken, requireRole('team_manager'), uploadToS3.fields([{ name: 'passport_img' }, { name: 'fullbody_img' }]), async (req, res) => {
    const { teamId, name, number, position } = req.body;
    
    // AWS S3 gives us the public URLs of the uploaded images
    const passportUrl = req.files['passport_img'] ? req.files['passport_img'][0].location : null;
    const fullbodyUrl = req.files['fullbody_img'] ? req.files['fullbody_img'][0].location : null;

    try {
        const result = await db.query(
            `INSERT INTO players (team_id, name, jersey_number, position, passport_url, fullbody_url) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [teamId, name, number, position, passportUrl, fullbodyUrl]
        );
        res.status(201).json(result.rows[0]); // Send new player back to frontend
    } catch (err) {
        res.status(500).json({ success: false, message: "Database Error" });
    }
});

// ==========================================
// 6. RECORD MATCH EVENT (SQL Transaction)
// ==========================================
app.post('/api/matches/:id/events', verifyToken, requireRole('league_owner'), async (req, res) => {
    const matchId = req.params.id;
    const { type, team, player } = req.body; // type = 'Goal', 'Yellow', 'Red'

    try {
        await db.query('BEGIN'); // Start Transaction

        // 1. Log event
        await db.query(`INSERT INTO match_events (match_id, event_type, player_name) VALUES ($1, $2, $3)`, [matchId, type, player]);

        // 2. If Goal, update match score
        if (type === 'Goal') {
            const column = team === 'home' ? 'home_score' : 'away_score';
            await db.query(`UPDATE matches SET ${column} = ${column} + 1 WHERE id = $1`, [matchId]);
            await db.query(`UPDATE players SET goals = goals + 1 WHERE name = $1`, [player]);
        }
        // 3. If Cards
        else if (type === 'Red') {
            await db.query(`UPDATE players SET red_cards = red_cards + 1 WHERE name = $1`, [player]);
        }

        await db.query('COMMIT'); // Save changes
        res.json({ success: true });
    } catch (err) {
        await db.query('ROLLBACK'); // Cancel changes if error
        res.status(500).json({ success: false, message: "Failed to record event" });
    }
});

// ==========================================
// 7. MONIEPOINT WEBHOOK (Secure Payment Validation)
// ==========================================
app.post('/api/webhooks/moniepoint', (req, res) => {
    const secret = process.env.MONIEPOINT_WEBHOOK_SECRET;
    const signature = req.headers['x-moniepoint-signature'];

    // Generate cryptographic hash of the payload
    const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex');

    // Reject hackers sending fake webhook payloads
    if (hash !== signature) return res.status(400).send("Invalid Signature");

    // Payment is valid! Update league status to Active
    if (req.body.eventType === 'TRANSFER_RECEIVED' && req.body.status === 'SUCCESSFUL') {
        const leagueId = req.body.reference.split('-')[1]; // Extracts ID from 'REF-123-Time'
        db.query(`UPDATE leagues SET status = 'Active' WHERE id = $1`, [leagueId]);
    }

    res.status(200).send("OK");
});

// ==========================================
// 8. LIVE BROADCAST & WEBSOCKETS (The Studio)
// ==========================================
const GLOBAL_YOUTUBE_POOL = [
    { key: process.env.YT_KEY_1, usedByLeague: null, usedByMatch: null },
    { key: process.env.YT_KEY_2, usedByLeague: null, usedByMatch: null }
];

io.on('connection', (socket) => {
    let ffmpegProcess;
    let assignedKeyObj = null;

    // Fans join the match room
    socket.on('join-match-room', (matchId) => socket.join(matchId));

    // Admin triggers graphics on Fan's screen
    socket.on('trigger-stats-graphic', (payload) => io.to(payload.matchId).emit('show-stats-graphic', payload));
    socket.on('trigger-lower-third', (payload) => io.to(payload.matchId).emit('show-lower-third', payload));
    socket.on('trigger-scorebug-update', (payload) => io.to(payload.matchId).emit('update-scorebug', payload));

    // FFMPEG Stream Engine
    socket.on('start-broadcast', (data) => {
        const { matchId, leagueId } = data;

        // Check the 4-match limit per league
        const activeMatches = GLOBAL_YOUTUBE_POOL.filter(k => k.usedByLeague === leagueId).length;
        if (activeMatches >= 4) return socket.emit('broadcast-error', 'Limit Reached: Max 4 live matches allowed.');

        assignedKeyObj = GLOBAL_YOUTUBE_POOL.find(k => k.usedByMatch === null);
        if (!assignedKeyObj) return socket.emit('broadcast-error', 'Server full.');

        assignedKeyObj.usedByLeague = leagueId;
        assignedKeyObj.usedByMatch = matchId;

        const rtmpDest = `rtmp://a.rtmp.youtube.com/live2/${assignedKeyObj.key}`;
        
        ffmpegProcess = spawn('ffmpeg', [
            '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '2500k', '-c:a', 'aac', '-b:a', '128k', '-f', 'flv', rtmpDest
        ]);
        
        // Save the YouTube Playback URL to the database so Fans can watch it!
        // db.query(`UPDATE matches SET stream_url = $1 WHERE id = $2`, [`https://youtube.com/embed/...`, matchId]);
    });

    socket.on('video-stream', (chunk) => { if (ffmpegProcess) ffmpegProcess.stdin.write(chunk); });

    socket.on('disconnect', () => {
        if (ffmpegProcess) ffmpegProcess.kill('SIGINT');
        if (assignedKeyObj) { assignedKeyObj.usedByLeague = null; assignedKeyObj.usedByMatch = null; assignedKeyObj = null; }
    });
});

// ==========================================
// 9. SUPER ADMIN AUTO-CREATOR BOOT SCRIPT
// ==========================================
async function createMasterAdmin() {
    try {
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, salt);
        // Inserts ONLY if the email doesn't exist yet
        await db.query(`INSERT INTO users (first_name, last_name, email, password_hash, role) 
                        VALUES ('Super', 'Admin', $1, $2, 'super_admin') ON CONFLICT (email) DO NOTHING`, 
                        [process.env.ADMIN_EMAIL, hash]);
        console.log('✅ Super Admin Secured');
    } catch (e) { console.error('Failed to create Master Admin:', e.message); }
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 RefAI Backend running on port ${PORT}`);
    createMasterAdmin();
});