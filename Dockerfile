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

# Copy package files for dependency caching
COPY package.json package-lock.json ./

# Install all deps first (including playwright)
RUN npm ci --ignore-scripts

# Now install chromium AFTER npm ci (so it matches the installed playwright version)
RUN npx playwright install chromium

# Copy app code
COPY . .

# Create output directory
RUN mkdir -p output/jobs

EXPOSE 4173

ENV PORT=4173
ENV NODE_ENV=production

CMD ["node", "--max-old-space-size=4096", "server.js"]
