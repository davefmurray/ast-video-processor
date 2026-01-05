const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');

// Import routes
const videoRoutes = require('./routes/video');

const app = express();
const PORT = process.env.PORT || 3002;

// CORS configuration - allow all origins for now
app.use(cors());

// JSON body parser (for non-multipart routes)
app.use(express.json());

// Mount video routes at /api
app.use('/api', videoRoutes);

// Health endpoint
app.get('/health', async (req, res) => {
  // Check if FFmpeg is available
  let ffmpegAvailable = false;
  try {
    await new Promise((resolve) => {
      const ffmpeg = spawn('ffmpeg', ['-version']);
      ffmpeg.on('close', (code) => {
        ffmpegAvailable = code === 0;
        resolve();
      });
      ffmpeg.on('error', () => {
        ffmpegAvailable = false;
        resolve();
      });
    });
  } catch (e) {
    ffmpegAvailable = false;
  }

  res.json({
    status: 'healthy',
    service: 'video-processor',
    version: '1.0.0',
    ffmpeg_available: ffmpegAvailable,
    supabase_configured: !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
    uptime: process.uptime()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`[video-processor] Server started on port ${PORT}`);
  console.log(`[video-processor] Health check available at http://localhost:${PORT}/health`);
  console.log(`[video-processor] API endpoints:`);
  console.log(`   POST /api/merge-and-upload - Merge video with explainer and upload to TekMetric`);
  console.log(`   POST /api/merge-only - Merge video with explainer (returns merged file)`);
  console.log(`   GET  /api/health - Video route health check`);
});
