// ========================================
// MAIN API ENTRY POINT
// ========================================

const express = require('express');
const cors = require('cors');
const { query } = require('./db');
const auth = require('./auth');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// ========================================
// HEALTH CHECK
// ========================================
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString() 
    });
});

// ========================================
// AUTH ROUTES
// ========================================

// REGISTER
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, displayName } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        
        // Check if user exists
        const existing = await query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );
        
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Email already registered' });
        }
        
        // Hash password
        const hashedPassword = await auth.hashPassword(password);
        
        // Create user
        const result = await query(
            `INSERT INTO users (email, display_name, password_hash, role) 
             VALUES ($1, $2, $3, 'user') 
             RETURNING id, email, display_name, role, created_at`,
            [email, displayName || email.split('@')[0], hashedPassword]
        );
        
        const user = result.rows[0];
        
        // Generate token
        const token = auth.generateToken(user);
        
        res.status(201).json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                displayName: user.display_name,
                role: user.role
            },
            token
        });
        
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// LOGIN
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        
        const result = await query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result.rows[0];
        
        const valid = await auth.verifyPassword(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = auth.generateToken(user);
        
        res.json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                displayName: user.display_name,
                role: user.role
            },
            token
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// GET PROFILE
app.get('/api/auth/profile', auth.authenticate, async (req, res) => {
    try {
        res.json({
            success: true,
            user: {
                id: req.user.id,
                email: req.user.email,
                displayName: req.user.display_name,
                role: req.user.role
            }
        });
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ error: 'Failed to get profile' });
    }
});

// ========================================
// WALLET ROUTES
// ========================================

// GET WALLET
app.get('/api/wallet', auth.authenticate, async (req, res) => {
    try {
        const result = await query(
            'SELECT * FROM wallets WHERE user_id = $1',
            [req.user.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Wallet not found' });
        }
        
        res.json({
            success: true,
            wallet: result.rows[0]
        });
        
    } catch (error) {
        console.error('Wallet error:', error);
        res.status(500).json({ error: 'Failed to get wallet' });
    }
});

// GET TRANSACTIONS
app.get('/api/wallet/transactions', auth.authenticate, async (req, res) => {
    try {
        const result = await query(
            `SELECT * FROM transactions 
             WHERE user_id = $1 
             ORDER BY created_at DESC 
             LIMIT 50`,
            [req.user.id]
        );
        
        res.json({
            success: true,
            transactions: result.rows
        });
        
    } catch (error) {
        console.error('Transactions error:', error);
        res.status(500).json({ error: 'Failed to get transactions' });
    }
});

// ========================================
// ORDER ROUTES
// ========================================

// CREATE ORDER
app.post('/api/orders', auth.authenticate, async (req, res) => {
    try {
        const { targetUrl, services, totalQuantity, totalPrice } = req.body;
        
        if (!targetUrl || !services || services.length === 0) {
            return res.status(400).json({ error: 'Target URL and services required' });
        }
        
        // Check wallet balance
        const walletResult = await query(
            'SELECT balance FROM wallets WHERE user_id = $1',
            [req.user.id]
        );
        
        if (walletResult.rows.length === 0) {
            return res.status(404).json({ error: 'Wallet not found' });
        }
        
        const balance = parseFloat(walletResult.rows[0].balance);
        if (balance < totalPrice) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        // Create order
        const orderResult = await query(
            `INSERT INTO orders (user_id, target_url, services, total_quantity, total_price, status) 
             VALUES ($1, $2, $3, $4, $5, 'pending') 
             RETURNING *`,
            [req.user.id, targetUrl, JSON.stringify(services), totalQuantity, totalPrice]
        );
        
        const order = orderResult.rows[0];
        
        // Deduct from wallet
        await query(
            `UPDATE wallets 
             SET balance = balance - $1 
             WHERE user_id = $2`,
            [totalPrice, req.user.id]
        );
        
        // Create transaction
        await query(
            `INSERT INTO transactions (user_id, type, amount, description, status, reference) 
             VALUES ($1, 'debit', $2, $3, 'completed', $4)`,
            [req.user.id, totalPrice, `Order ${order.id}`, `ORD-${Date.now()}`]
        );
        
        res.status(201).json({
            success: true,
            order: order
        });
        
    } catch (error) {
        console.error('Create order error:', error);
        res.status(500).json({ error: 'Failed to create order' });
    }
});

// GET USER ORDERS
app.get('/api/orders', auth.authenticate, async (req, res) => {
    try {
        const result = await query(
            `SELECT * FROM orders 
             WHERE user_id = $1 
             ORDER BY created_at DESC 
             LIMIT 50`,
            [req.user.id]
        );
        
        res.json({
            success: true,
            orders: result.rows
        });
        
    } catch (error) {
        console.error('Get orders error:', error);
        res.status(500).json({ error: 'Failed to get orders' });
    }
});

// GET ORDER DETAILS WITH BATCHES
app.get('/api/orders/:id', auth.authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        
        const orderResult = await query(
            'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
            [id, req.user.id]
        );
        
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        const order = orderResult.rows[0];
        
        const batchesResult = await query(
            'SELECT * FROM batches WHERE order_id = $1 ORDER BY scheduled_time ASC',
            [id]
        );
        
        res.json({
            success: true,
            order: order,
            batches: batchesResult.rows
        });
        
    } catch (error) {
        console.error('Get order details error:', error);
        res.status(500).json({ error: 'Failed to get order details' });
    }
});

// ========================================
// ADMIN ROUTES
// ========================================

// GET ALL USERS
app.get('/api/admin/users', auth.authenticate, auth.requireAdmin, async (req, res) => {
    try {
        const result = await query(
            'SELECT id, email, display_name, role, created_at FROM users ORDER BY created_at DESC'
        );
        
        res.json({
            success: true,
            users: result.rows
        });
        
    } catch (error) {
        console.error('Admin users error:', error);
        res.status(500).json({ error: 'Failed to get users' });
    }
});

// GET ALL ORDERS (Admin)
app.get('/api/admin/orders', auth.authenticate, auth.requireAdmin, async (req, res) => {
    try {
        const result = await query(
            `SELECT o.*, u.email as user_email 
             FROM orders o 
             LEFT JOIN users u ON o.user_id = u.id 
             ORDER BY o.created_at DESC 
             LIMIT 50`
        );
        
        res.json({
            success: true,
            orders: result.rows
        });
        
    } catch (error) {
        console.error('Admin orders error:', error);
        res.status(500).json({ error: 'Failed to get orders' });
    }
});

// GET ALL TRANSACTIONS (Admin)
app.get('/api/admin/transactions', auth.authenticate, auth.requireAdmin, async (req, res) => {
    try {
        const result = await query(
            `SELECT t.*, u.email as user_email 
             FROM transactions t 
             LEFT JOIN users u ON t.user_id = u.id 
             ORDER BY t.created_at DESC 
             LIMIT 50`
        );
        
        res.json({
            success: true,
            transactions: result.rows
        });
        
    } catch (error) {
        console.error('Admin transactions error:', error);
        res.status(500).json({ error: 'Failed to get transactions' });
    }
});

// APPROVE WALLET FUNDING
app.post('/api/admin/approve-funding', auth.authenticate, auth.requireAdmin, async (req, res) => {
    try {
        const { userId, amount, reference } = req.body;
        
        if (!userId || !amount || !reference) {
            return res.status(400).json({ error: 'User ID, amount, and reference required' });
        }
        
        // Start transaction
        await query('BEGIN');
        
        // Update wallet
        await query(
            `UPDATE wallets 
             SET balance = balance + $1 
             WHERE user_id = $2`,
            [amount, userId]
        );
        
        // Create transaction record
        await query(
            `INSERT INTO transactions (user_id, type, amount, description, status, reference) 
             VALUES ($1, 'credit', $2, $3, 'completed', $4)`,
            [userId, amount, 'Wallet funding approved', reference]
        );
        
        // Update approval status
        await query(
            `UPDATE approvals 
             SET status = 'approved', approved_at = NOW() 
             WHERE reference = $1`,
            [reference]
        );
        
        await query('COMMIT');
        
        res.json({
            success: true,
            message: 'Wallet funded successfully'
        });
        
    } catch (error) {
        await query('ROLLBACK');
        console.error('Approve funding error:', error);
        res.status(500).json({ error: 'Failed to approve funding' });
    }
});

// PROCESS BATCHES (Admin or Cron)
app.post('/api/admin/process-batches', async (req, res) => {
    try {
        // This endpoint is called by cron-job.org
        // We'll use a simple API key for security
        const apiKey = req.headers['x-api-key'];
        if (apiKey !== process.env.CRON_API_KEY) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        
        await processBatches();
        res.json({ success: true, message: 'Batches processed' });
        
    } catch (error) {
        console.error('Process batches error:', error);
        res.status(500).json({ error: 'Failed to process batches' });
    }
});

// ========================================
// SCHEDULER - PROCESS BATCHES
// ========================================

async function processBatches() {
    console.log('🔄 Processing batches...');
    
    // Check quiet hours (WAT - West African Time)
    const now = new Date();
    const watHour = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lagos' })).getHours();
    const quietStart = 0; // 12 AM
    const quietEnd = 6;   // 6 AM
    
    if (watHour >= quietStart && watHour < quietEnd) {
        console.log('🌙 Quiet hours active, skipping batch processing');
        return;
    }
    
    // Get pending batches
    const result = await query(
        `SELECT * FROM batches 
         WHERE status = 'pending' 
           AND scheduled_time <= NOW() 
         ORDER BY scheduled_time ASC 
         LIMIT 2`
    );
    
    if (result.rows.length === 0) {
        console.log('ℹ️ No pending batches found');
        return;
    }
    
    console.log(`📦 Processing ${result.rows.length} batches...`);
    
    for (const batch of result.rows) {
        try {
            // Update to processing
            await query(
                `UPDATE batches 
                 SET status = 'processing', started_at = NOW() 
                 WHERE id = $1`,
                [batch.id]
            );
            
            // TODO: Submit to Betalogs API
            // For now, just mark as completed (for testing)
            await query(
                `UPDATE batches 
                 SET status = 'completed', 
                     delivered = quantity, 
                     completed_at = NOW() 
                 WHERE id = $1`,
                [batch.id]
            );
            
            console.log(`✅ Batch ${batch.id} completed`);
            
        } catch (error) {
            console.error(`❌ Batch ${batch.id} failed:`, error);
            await query(
                `UPDATE batches SET status = 'failed' WHERE id = $1`,
                [batch.id]
            );
        }
    }
    
    // Check if all batches for any order are complete
    // Get orders with all batches completed
    const completedOrders = await query(
        `SELECT o.id, o.user_id, COUNT(b.id) as total_batches, 
                SUM(CASE WHEN b.status = 'completed' THEN 1 ELSE 0 END) as completed_batches
         FROM orders o
         JOIN batches b ON o.id = b.order_id
         WHERE o.status = 'pending'
         GROUP BY o.id, o.user_id
         HAVING COUNT(b.id) = SUM(CASE WHEN b.status = 'completed' THEN 1 ELSE 0 END)`
    );
    
    for (const order of completedOrders.rows) {
        // Update order status to completed
        await query(
            `UPDATE orders SET status = 'completed', updated_at = NOW() WHERE id = $1`,
            [order.id]
        );
        console.log(`✅ Order ${order.id} completed`);
    }
}

// ========================================
// EXPORT FOR VERCEL
// ========================================

// Export the app for Vercel
module.exports = app;

// Export the processBatches function for cron
module.exports.processBatches = processBatches;

// For local development
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
}
