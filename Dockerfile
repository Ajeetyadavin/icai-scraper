FROM node:22-slim

# Install Playwright system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libwayland-client0 \
    fonts-noto-cjk \
    fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better caching
COPY package.json package-lock.json ./

# Install dependencies (skip playwright postinstall, we'll do it manually)
RUN npm ci --omit=dev && npx playwright install chromium

# Copy app code
COPY . .

# Create output directory
RUN mkdir -p output/jobs

# Expose port
EXPOSE 4173

ENV PORT=4173
ENV NODE_ENV=production

# Start server with extra memory
CMD ["node", "--max-old-space-size=4096", "server.js"]
