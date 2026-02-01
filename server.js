
import 'dotenv/config';
import express from 'express';
import mysql from 'mysql2/promise';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import nodemailer from 'nodemailer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { google } from 'googleapis';
import { Readable } from 'stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'rahasia_dimensi_suara_2024';

app.use(cors());
app.use(express.json());

// --- GOOGLE API SETUP ---
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file',
    ],
});

const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });

const isGoogleReady = () => !!(process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_SHEET_ID);

// Helper to upload file to Google Drive
async function uploadToDrive(file, folderId, namePrefix = '') {
    if (!isGoogleReady()) return null;
    try {
        const fileMetadata = {
            name: namePrefix + file.originalname,
            parents: [folderId],
        };
        const media = {
            mimeType: file.mimetype,
            body: fs.createReadStream(file.path),
        };
        const response = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, webViewLink',
        });
        return response.data;
    } catch (error) {
        console.error('Drive Upload Error:', error);
        return null;
    }
}

// Helper to create folder in Google Drive
async function createDriveFolder(name, parentId) {
    if (!isGoogleReady()) return null;
    try {
        const fileMetadata = {
            name: name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: parentId ? [parentId] : [],
        };
        const folder = await drive.files.create({
            resource: fileMetadata,
            fields: 'id',
        });
        return folder.data.id;
    } catch (error) {
        console.error('Folder Creation Error:', error);
        return null;
    }
}

// Helper to append row to Google Sheets
async function appendToSheet(range, values) {
    if (!isGoogleReady()) return;
    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: range,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [values] },
        });
    } catch (error) {
        console.error('Sheets Append Error:', error);
    }
}

// --- KONFIGURASI SMTP EMAIL ---
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com', 
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: true, 
    auth: {
        user: process.env.SMTP_USER || 'email@domain.com',
        pass: process.env.SMTP_PASS || 'password_app'
    }
});

// --- KONFIGURASI FOLDER UPLOAD (LOCAL STORAGE) ---
const UPLOAD_DIRS = {
    base: path.join(__dirname, 'public/uploads'),
    covers: path.join(__dirname, 'public/uploads/covers'),
    audio: path.join(__dirname, 'public/uploads/audio'),
    contracts: path.join(__dirname, 'public/uploads/contracts'),
    others: path.join(__dirname, 'public/uploads/others')
};

Object.values(UPLOAD_DIRS).forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === 'coverArt') cb(null, UPLOAD_DIRS.covers);
        else if (file.fieldname === 'audioFiles') cb(null, UPLOAD_DIRS.audio);
        else if (['ktpFile', 'npwpFile', 'signatureFile'].includes(file.fieldname)) cb(null, UPLOAD_DIRS.contracts);
        else cb(null, UPLOAD_DIRS.others);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `${uniqueSuffix}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, '_')}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 150 * 1024 * 1024 } // 150MB
});

// --- DATABASE CONFIGURATION ---
const dbConfig = {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root', 
    password: process.env.DB_PASSWORD || '', 
    database: process.env.DB_NAME || 'dimensi_suara_db',
    waitForConnections: true,
    connectionLimit: 10
};

const db = mysql.createPool(dbConfig);

const getFileUrl = (req, folderName, filename) => {
    if (!filename) return '';
    return `${req.protocol}://${req.get('host')}/uploads/${folderName}/${filename}`;
};

// --- ROUTES ---

app.get('/api/health-check', async (req, res) => {
    const status = {
        database: { connected: false, message: 'Checking...' },
        storage: { connected: false, message: 'Checking...' },
        google: { connected: isGoogleReady(), message: isGoogleReady() ? 'Configured' : 'Missing Config' }
    };
    try {
        await db.query('SELECT 1');
        status.database = { connected: true, message: 'Online' };
    } catch(e) { status.database = { connected: false, message: e.message }; }
    
    try {
        fs.accessSync(UPLOAD_DIRS.base, fs.constants.W_OK);
        status.storage = { connected: true, message: 'Writable' };
    } catch(e) { status.storage = { connected: false, message: e.message }; }
    
    res.json(status);
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
        if (rows.length === 0) return res.status(401).json({ error: 'User tidak ditemukan' });
        const user = rows[0];
        const validPass = await bcrypt.compare(password, user.password_hash);
        if (!validPass) return res.status(401).json({ error: 'Password salah' });
        const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ success: true, token, user: { username: user.username, role: user.role, fullName: user.full_name } });
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// --- RELEASE UPLOAD ---
app.post('/api/upload-release', upload.fields([{ name: 'coverArt', maxCount: 1 }, { name: 'audioFiles' }]), async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const metadata = JSON.parse(req.body.metadata);
        const coverArtFile = req.files['coverArt'] ? req.files['coverArt'][0] : null;
        const coverArtUrl = coverArtFile ? getFileUrl(req, 'covers', coverArtFile.filename) : '';

        const [releaseResult] = await connection.query(
            `INSERT INTO releases (title, upc, status, artist_name, label, language, version, is_new_release, planned_release_date, cover_art_url, selected_platforms, submission_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [metadata.title, metadata.upc, 'Pending', metadata.primaryArtists.join(', '), metadata.label, metadata.language, metadata.version, metadata.isNewRelease ? 1 : 0, metadata.plannedReleaseDate || null, coverArtUrl, JSON.stringify(metadata.selectedPlatforms || [])]
        );
        const releaseId = releaseResult.insertId;

        const uploadedAudioFiles = req.files['audioFiles'] || [];
        const trackLinks = [];

        for (let i = 0; i < metadata.tracks.length; i++) {
            const track = metadata.tracks[i];
            const audioFile = uploadedAudioFiles[i];
            const audioUrl = audioFile ? getFileUrl(req, 'audio', audioFile.filename) : '';
            trackLinks.push(audioUrl);

            await connection.query(
                `INSERT INTO tracks (release_id, title, track_number, isrc, duration, genre, explicit_lyrics, composer, lyricist, lyrics, audio_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [releaseId, track.title, track.trackNumber, track.isrc, track.duration, track.genre, track.explicitLyrics, track.composer, track.lyricist, track.lyrics, audioUrl]
            );
        }

        // --- GOOGLE SYNC RELEASE ---
        if (isGoogleReady()) {
            const releaseFolderId = await createDriveFolder(`${metadata.primaryArtists[0]} - ${metadata.title}`, process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID);
            let gDriveLink = '';
            if (releaseFolderId) {
                if (coverArtFile) await uploadToDrive(coverArtFile, releaseFolderId, 'COVER_');
                for (let i = 0; i < uploadedAudioFiles.length; i++) {
                    await uploadToDrive(uploadedAudioFiles[i], releaseFolderId, `TRACK_${i+1}_`);
                }
                gDriveLink = `https://drive.google.com/drive/folders/${releaseFolderId}`;
            }
            
            await appendToSheet('Releases!A:H', [
                new Date().toLocaleString(),
                'Release',
                metadata.primaryArtists.join(', '),
                metadata.title,
                metadata.upc || 'N/A',
                'Pending',
                gDriveLink,
                metadata.label
            ]);
        }

        await connection.commit();
        res.json({ success: true, message: "Rilis berhasil diupload dan disinkronkan!" });
    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// --- CONTRACT UPLOAD ---
app.post('/api/contracts', upload.fields([{ name: 'ktpFile' }, { name: 'npwpFile' }, { name: 'signatureFile' }]), async (req, res) => {
    try {
        const metadata = JSON.parse(req.body.metadata);
        const ktpFile = req.files['ktpFile'] ? req.files['ktpFile'][0] : null;
        const npwpFile = req.files['npwpFile'] ? req.files['npwpFile'][0] : null;
        const signatureFile = req.files['signatureFile'] ? req.files['signatureFile'][0] : null;

        const ktpUrl = ktpFile ? getFileUrl(req, 'contracts', ktpFile.filename) : '';
        const npwpUrl = npwpFile ? getFileUrl(req, 'contracts', npwpFile.filename) : '';
        const signatureUrl = signatureFile ? getFileUrl(req, 'contracts', signatureFile.filename) : '';

        const sql = `INSERT INTO contracts 
            (contract_number, artist_name, legal_name, nik, phone, country, address, province, city, start_date, duration_years, royalty_rate, status, ktp_url, npwp_url, signature_url) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        
        const values = [
            metadata.contractNumber, metadata.artistName, metadata.legalName, metadata.nik, metadata.phone, 
            metadata.country, metadata.address, metadata.province, metadata.city, metadata.startDate, 
            metadata.durationYears, metadata.royaltyRate, 'Pending', ktpUrl, npwpUrl, signatureUrl
        ];
        
        await db.query(sql, values);

        // --- GOOGLE SYNC CONTRACT ---
        if (isGoogleReady()) {
            const contractFolderId = await createDriveFolder(`CONTRACT - ${metadata.artistName}`, process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID);
            let gDriveLink = '';
            if (contractFolderId) {
                if (ktpFile) await uploadToDrive(ktpFile, contractFolderId, 'KTP_');
                if (npwpFile) await uploadToDrive(npwpFile, contractFolderId, 'NPWP_');
                if (signatureFile) await uploadToDrive(signatureFile, contractFolderId, 'SIGN_');
                gDriveLink = `https://drive.google.com/drive/folders/${contractFolderId}`;
            }

            await appendToSheet('Contracts!A:G', [
                new Date().toLocaleString(),
                metadata.contractNumber,
                metadata.artistName,
                metadata.legalName,
                'Pending',
                gDriveLink,
                metadata.phone
            ]);
        }

        res.json({ success: true, message: 'Kontrak berhasil disimpan!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Settings & Setup Admin Routes (Simplified for space)
app.get('/api/setup-admin', async (req, res) => {
    try {
        const hash = await bcrypt.hash('admin123', 10);
        await db.query(`INSERT INTO users (username, email, password_hash, role, full_name) VALUES ('admin', 'admin@mail.com', ?, 'Admin', 'Super Admin') ON DUPLICATE KEY UPDATE role='Admin'`, [hash]);
        res.json({ success: true, message: 'Admin created: admin / admin123' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/platforms', async (req, res) => {
    const [rows] = await db.query("SELECT * FROM platforms ORDER BY name ASC");
    res.json(rows);
});

app.get('/api/releases', async (req, res) => {
    const [rows] = await db.query('SELECT * FROM releases ORDER BY submission_date DESC');
    res.json(rows);
});

app.get('/api/admins', async (req, res) => {
    const [rows] = await db.query("SELECT id, username, email, full_name, created_at FROM users WHERE role = 'Admin'");
    res.json(rows);
});

app.get('/api/statistics', async (req, res) => {
    const [counts] = await db.query("SELECT COUNT(*) as total FROM tracks");
    res.json({ catalog: { totalTracks: counts[0].total, albums: 0, singles: 0 }, platforms: [] });
});

app.get('/api/contracts', async (req, res) => {
    const [rows] = await db.query('SELECT * FROM contracts ORDER BY created_at DESC');
    res.json(rows);
});

// Static files
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
const distPath = path.resolve(__dirname, 'dist');
app.use(express.static(distPath));

app.get('*', (req, res) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
