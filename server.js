const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 5000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://your-frontend-service.onrender.com';

// Queue system for Discord operations
const discordQueue = [];
let isProcessingQueue = false;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// CORS configuration
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// In-memory storage (for simple deployment)
let messages = [];

// Load messages from file if exists
const MESSAGES_FILE = 'messages.json';
if (fs.existsSync(MESSAGES_FILE)) {
    try {
        const data = fs.readFileSync(MESSAGES_FILE, 'utf8');
        messages = JSON.parse(data);
        console.log(`📝 Loaded ${messages.length} messages from ${MESSAGES_FILE}`);
    } catch (error) {
        console.error('Error loading messages file:', error.message);
        messages = [];
    }
}

// Save messages to file
// Note: Render's filesystem is ephemeral; consider using a database (e.g., PostgreSQL) for persistence
function saveMessages() {
    try {
        fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
        console.log(`💾 Saved ${messages.length} messages to ${MESSAGES_FILE}`);
    } catch (error) {
        console.error('Error saving messages:', error.message);
    }
}

// Discord configuration mapping categories to channel IDs
const CATEGORY_CHANNELS = {
    'Entertainment': 1413856614510755880,
    'Education': 1413881799322636319,
    'Website': 1413881852451885266,
    'Hack': 1413881887428055193,
    'Others': 1413881920248615143
};

// Function to send post to Discord channel via Discord API
async function sendToDiscordChannel(postData) {
    const { topic, description, link, tag } = postData;
    const channelId = CATEGORY_CHANNELS[tag];
    
    if (!channelId) {
        console.log(`No Discord channel configured for category: ${tag}`);
        return false;
    }

    const discordToken = process.env.DISCORD_TOKEN;
    if (!discordToken) {
        console.error('Discord token not available');
        return false;
    }

    // Create plain text message format
    let messageContent = `# ${topic}\n> ${description}`;
    if (link && link.trim()) {
        messageContent += `\n${link}`;
    }

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.post(
                `https://discord.com/api/v10/channels/${channelId}/messages`,
                { content: messageContent },
                {
                    headers: {
                        'Authorization': `Bot ${discordToken}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );
            console.log(`✅ Post sent to Discord channel #${tag}: [${tag}] ${topic}`);
            return true;
        } catch (error) {
            if (error.response?.status === 429 && attempt < maxRetries) {
                const retryAfter = (error.response.data.retry_after * 1000) || 1000;
                console.log(`Rate limited, retrying after ${retryAfter}ms (attempt ${attempt}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, retryAfter));
                continue;
            }
            console.error(`❌ Failed to send to Discord (attempt ${attempt}/${maxRetries}):`, 
                error.response?.data || error.message);
            return false;
        }
    }
    return false;
}

// Queue processing function
async function processDiscordQueue() {
    if (isProcessingQueue || discordQueue.length === 0) {
        return;
    }

    isProcessingQueue = true;
    console.log(`Processing Discord queue: ${discordQueue.length} items`);

    while (discordQueue.length > 0) {
        const postData = discordQueue.shift();
        try {
            await sendToDiscordChannel(postData);
            // Add delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            console.error('Error processing Discord queue item:', error.message);
        }
    }

    isProcessingQueue = false;
    console.log('Discord queue processing completed');
}

// API Routes
app.get('/api/messages', (req, res) => {
    res.json(messages);
});

app.post('/api/upload', async (req, res) => {
    try {
        const { topic, description, message, link, tag, source } = req.body;
        
        if (!tag || (!description && !message)) {
            return res.status(400).json({ error: 'Tag and description/message are required' });
        }

        const newPost = {
            topic: topic || '',
            description: description || message || '',
            message: message || description || '',
            link: link || '',
            tag: tag,
            source: source || 'discord',
            timestamp: new Date().toISOString(),
            id: Date.now() + Math.random()
        };

        messages.unshift(newPost);
        
        // Keep only last 100 messages
        if (messages.length > 100) {
            messages = messages.slice(0, 100);
        }

        saveMessages();
        
        const logMessage = topic ? `[${tag}] ${topic}` : `[${tag}] ${description || message}`;
        console.log(`New post added: ${logMessage}`);

        // If post came from website, add to Discord queue
        if (source === 'website') {
            console.log(`Adding website post to Discord queue: ${logMessage}`);
            discordQueue.push(newPost);
            setImmediate(() => processDiscordQueue());
        }
        
        res.json({ success: true, message: 'Post uploaded successfully' });
    } catch (error) {
        console.error('Error uploading post:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Delete post API endpoint
app.delete('/api/delete/:postId', async (req, res) => {
    try {
        const postId = req.params.postId;
        
        const postToDelete = messages.find(post => post.id == postId);
        
        if (!postToDelete) {
            return res.status(404).json({ error: 'Post not found' });
        }

        messages = messages.filter(post => post.id != postId);
        saveMessages();

        console.log(`Post deleted: [${postToDelete.tag}] ${postToDelete.topic || postToDelete.description}`);
        res.json({ success: true, message: 'Post deleted successfully' });
    } catch (error) {
        console.error('Error deleting post:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'OK', messages: messages.length });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Message Board Server running on port ${PORT}`);
    console.log(`📝 ${messages.length} messages loaded`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Saving messages before shutdown...');
    saveMessages();
    process.exit(0);
});
