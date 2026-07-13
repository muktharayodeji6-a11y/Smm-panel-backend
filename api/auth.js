// ========================================
// AUTHENTICATION MIDDLEWARE
// ========================================

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('./db');

// JWT Secret (from environment variables)
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

// ========================================
// HASH PASSWORD
// ========================================
async function hashPassword(password) {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
}

// ========================================
// VERIFY PASSWORD
// ========================================
async function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}

// ========================================
// GENERATE JWT TOKEN
// ========================================
function generateToken(user) {
    return jwt.sign(
        { 
            id: user.id, 
            email: user.email, 
            role: user.role 
        },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
}

// ========================================
// VERIFY JWT TOKEN
// ========================================
function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (error) {
        return null;
    }
}

// ========================================
// AUTH MIDDLEWARE FOR API ROUTES
// ========================================
async function authenticate(req, res, next) {
    try {
        // Get token from Authorization header
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token provided' });
        }
        
        const token = authHeader.split(' ')[1];
        const decoded = verifyToken(token);
        
        if (!decoded) {
            return res.status(401).json({ error: 'Invalid token' });
        }
        
        // Get user from database
        const result = await query(
            'SELECT * FROM users WHERE id = $1',
            [decoded.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'User not found' });
        }
        
        req.user = result.rows[0];
        next();
        
    } catch (error) {
        console.error('Auth error:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
}

// ========================================
// ADMIN MIDDLEWARE
// ========================================
async function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

module.exports = {
    hashPassword,
    verifyPassword,
    generateToken,
    verifyToken,
    authenticate,
    requireAdmin
};
