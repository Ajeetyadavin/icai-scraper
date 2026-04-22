# ICAI Student Card Bulk Data Extractor

High-performance automated scraper for extracting student card data from ICAI portal.

## Features

- ✅ Automated login & session management
- ✅ Batch PDF fetching with retry logic
- ✅ Structured data extraction from student cards
- ✅ Auto re-login on session expiry
- ✅ Streaming CSV export (chunked files)
- ✅ Error reporting & failed record tracking
- ✅ Real-time progress monitoring

## Requirements

- Node.js 14+
- npm

## Installation

```bash
npm install
```

## Configuration

Edit `.env` file with:
- ICAI credentials
- Student number range (prefix, start, count)
- Concurrency level
- Output directory

## Usage

```bash
npm start
```

Or directly:

```bash
node cli.js
```

## Vercel Deployment

Deploy instantly to Vercel with serverless support:

### Steps:
1. Visit [Vercel Dashboard](https://vercel.com/dashboard)
2. Click **"Add New"** → **"Project"**
3. **Import this GitHub repository** (`icai-scraper`)
4. **Add Environment Variables** in Vercel:
   - `ICAI_USER_ID` = Your ICAI email (e.g., WRO0873063@icai.org)
   - `ICAI_PASSWORD` = Your ICAI password
5. Click **"Deploy"** 🚀

Your app will be live at: `https://your-project-name.vercel.app`

### Features Available:
- ✅ Instant student search (SRN/Mobile)
- ✅ Bulk CSV download (range-based)
- ✅ CSV merge (multiple files)
- ✅ Login with connection status
- ✅ Advanced tools panel (toggle in corner)

### Development

For local development:

```bash
cp .env.example .env
# Edit .env with your ICAI credentials
npm install
npm start
```

Then visit: `http://localhost:4173`
2. Vercel will serve the UI from `web/` and route `/api/*` to the serverless handler in `api/[...path].js`.
3. The manual CSV upload merge flow works well on Vercel.

Notes:

- Live ICAI scraping uses Playwright and may hit serverless time limits on large requests.
- The local `output/` folder is not required on Vercel; server-file merge mode will be empty there.
- For heavy bulk exports, a separate long-running backend is still the safer option.

## Output

- CSV files in `output/` directory (chunked by 10K records)
- Logs in `logs/` directory
- Failed records in `output/failed_records.json`

## Performance

- Target: ~139 records/second
- Actual rate depends on server response time
- Adjustable concurrency in `.env`

## Project Structure

```
icai-scraper/
├── src/
│   ├── auth.js              # Login & authentication
│   ├── session.js           # Session management
│   ├── url-builder.js       # URL generation
│   ├── pdf-fetcher.js       # PDF retrieval
│   ├── pdf-parser.js        # PDF text extraction & parsing
│   ├── batch-processor.js   # Batch processing logic
│   ├── csv-exporter.js      # CSV export
│   ├── error-handler.js     # Error recovery
│   └── logger.js            # Logging
├── cli.js                   # Entry point
├── package.json
├── .env                     # Configuration
├── .gitignore
└── README.md
```

## Troubleshooting

1. **Login fails**: Check credentials in `.env`
2. **Session timeout**: Adjust `SESSION_TIMEOUT` in `.env`
3. **Slow performance**: Increase `CONCURRENCY` (carefully)
4. **Memory issues**: Reduce `BATCH_SIZE` or `CONCURRENCY`

---

Author: Ajeet  
Date: April 2026
