# Use node:18-bullseye for FFmpeg compatibility
FROM node:18-bullseye

# Install FFmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first (for layer caching)
COPY package*.json ./

# Install production dependencies only
RUN npm install --production

# Copy rest of source code
COPY . .

# Expose port 3002
EXPOSE 3002

# Start the server
CMD ["node", "server.js"]
