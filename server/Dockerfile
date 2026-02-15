FROM node:20-slim

# Install FFmpeg, OpenSSL, and curl (for healthcheck)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    openssl \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source
COPY . .

# Generate Prisma client
RUN npx prisma generate

EXPOSE 3001

# Use tsx to run TypeScript directly (no build step needed)
CMD ["npx", "tsx", "src/index.ts"]
