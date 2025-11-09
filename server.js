const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 4000;

// Sử dụng CORS cho tất cả các request đến server của bạn
app.use(cors());
app.use(express.json());

// Tên miền API bên thứ ba (Chỉ dùng để lấy dữ liệu JSON)
const API_DOMAIN = 'https://phimapi.com';

/**
 * Hàm hỗ trợ: Viết lại nội dung file M3U8.
 * Tất cả các URL tương đối (thường là các segment .ts) bên trong file M3U8 
 * phải được thay đổi để trỏ đến endpoint Proxy của chính server này.
 * Điều này đảm bảo trình phát video (FE) sẽ chỉ yêu cầu tài nguyên từ tên miền của bạn.
 * @param {string} m3u8Content - Nội dung gốc của file M3U8.
 * @param {string} baseUrl - URL cơ sở của file M3U8 gốc (ví dụ: https://s6.kkphimplayer6.com/...).
 * @param {string} serverBaseUrl - URL của server này (auto-detected from request).
 * @returns {string} Nội dung M3U8 đã được chỉnh sửa.
 */
function rewriteM3U8Content(m3u8Content, baseUrl, serverBaseUrl) {
    // Đảm bảo baseUrl kết thúc bằng dấu / để dễ dàng ghép chuỗi
    const base = baseUrl.endsWith('/') ? baseUrl : baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);

    // Dùng regex để tìm tất cả các dòng không phải là comments (bắt đầu bằng #) 
    // và không phải là URL tuyệt đối (không bắt đầu bằng http/https)
    // Sau đó thay thế chúng bằng URL tuyệt đối trỏ về endpoint segment proxy của bạn
    const rewrittenContent = m3u8Content.replace(
        /^(?!#)(?!http(s?):\/\/)(.*)$/gm, 
        (match) => {
            // Segment gốc, ví dụ: "segment_001.ts" hoặc "3500kb/hls/index.m3u8"
            const originalSegment = match.trim(); 
            
            // Bỏ qua dòng trống
            if (!originalSegment) return match;
            
            // Xây dựng URL Proxy mới trỏ đến Segment Proxy endpoint của bạn
            // Dùng encodeURIComponent để an toàn khi truyền URL gốc qua query param
            // QUAN TRỌNG: Phải là URL tuyệt đối (bắt đầu bằng http://) để HLS.js hoạt động
            const fullSegmentUrl = base + originalSegment;
            
            // Kiểm tra nếu là file m3u8 (master playlist trỏ đến variant playlist)
            // thì dùng endpoint /stream, còn không thì dùng /segment
            const endpoint = originalSegment.includes('.m3u8') 
                ? '/api/movie/stream' 
                : '/api/movie/segment';
            
            const proxyUrl = `${serverBaseUrl}${endpoint}?url=${encodeURIComponent(fullSegmentUrl)}`;
            
            return proxyUrl;
        }
    );

    return rewrittenContent;
}


// --- 1. ENDPOINT PROXY CHO FILE M3U8 (MANIFEST) ---
// Thay vì dùng req.protocol (có thể trả về 'http' trên Render)
app.get('/api/movie/stream', async (req, res) => {
  try {
    const m3u8Url = req.query.url;
    
    if (!m3u8Url) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    console.log('📥 Fetching m3u8:', m3u8Url);

    const response = await axios.get(m3u8Url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': new URL(m3u8Url).origin
      }
    });

    const m3u8Content = response.data;
    const originalM3U8Url = m3u8Url;

    // ✅ FIX: Kiểm tra nếu có header X-Forwarded-Proto thì dùng, không thì dùng req.protocol
    // Render và các cloud platform thường set header này
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('host');
    const serverBaseUrl = `${protocol}://${host}`;
    
    console.log('🌐 Auto-detected server URL:', serverBaseUrl);

    const rewrittenContent = rewriteM3U8Content(m3u8Content, originalM3U8Url, serverBaseUrl);

    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });

    res.send(rewrittenContent);
    console.log('✅ M3U8 served successfully');

  } catch (error) {
    console.error('❌ Error fetching m3u8:', error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch m3u8',
      details: error.message
    });
  }
});


// --- 2. ENDPOINT PROXY CHO TỪNG SEGMENT VIDEO (.TS) ---
app.get("/api/movie/segment", async (req, res) => {
    const originalSegmentUrl = req.query.url; // Lấy URL Segment gốc (đã được encode)

    if (!originalSegmentUrl) {
        return res.status(400).json({ message: "Segment URL is required" });
    }

    try {
        // Yêu cầu Server-to-Server đến URL Segment video gốc
        const response = await axios({
            method: 'get',
            url: originalSegmentUrl,
            responseType: 'stream', // Quan trọng: Truyền tải dạng stream để xử lý file lớn hiệu quả
            timeout: 30000, // 30s timeout cho segment
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://player.phimapi.com/'
            }
        });

        // Đặt CORS header
        res.setHeader('Access-Control-Allow-Origin', '*');

        // Set Content-Type cho segment (thường là video/MP2T cho .ts)
        res.setHeader('Content-Type', response.headers['content-type'] || 'video/MP2T');
        
        // Cache segments
        res.setHeader('Cache-Control', 'public, max-age=31536000');

        // Truyền tải dữ liệu từ API bên thứ ba về thẳng Front-end
        response.data.pipe(res);

    } catch (error) {
        console.error('❌ [Segment Error]', error.message);
        res.status(error.response?.status || 500).json({ 
            message: 'Error fetching video segment', 
            detail: error.message 
        });
    }
});


// --- CÁC ENDPOINT DATA JSON CŨ CỦA BẠN (GIỮ NGUYÊN) ---

app.get("/", async (req, res) => {
    res.status(200).json({
        message: "Welcome to the Movie API",
        version: "1.0.0",
        endpoints: {
            movies: "/api/movies/new?page=1",
            movieDetail: "/api/movies/slug/:slug",
            categories: "/api/categories",
            countries: "/api/country",
            search: "/api/movies/search?keyword=...",
            stream: "/api/movie/stream?url=...",
            segment: "/api/movie/segment?url=..."
        }
    });
});

app.get("/api/movies/new", async(req, res) => {
    const page = req.query.page || 1;
    try {
        const response = await axios.get(`${API_DOMAIN}/danh-sach/phim-moi-cap-nhat?page=${page}`);
        res.json(response.data);
    } catch (error) {
        res.status(500).json({message: 'Error fetching new movies', error: error.message});
    }
});

app.get("/api/movies/slug/:slug", async(req, res) =>{
    const slug = req.params.slug;
    try {
        const response = await axios.get(`${API_DOMAIN}/phim/${slug}`);
        const movieData = response.data;
        res.json(movieData);
    } catch (error) {
        res.status(500).json({ message: "Error fetching movie details" });
    }
});

app.get("/api/categories", async(req, res) =>{
    try {
        const response = await axios.get(`${API_DOMAIN}/the-loai`);
        const categories = response.data;
        res.json(categories);
    } catch (error) {
        res.status(500).json({ message: "Error fetching movies categories" });
    }
});

app.get("/api/country", async(req, res) =>{
    try {
        const response = await axios.get(`${API_DOMAIN}/quoc-gia`);
        const country = response.data;
        res.json(country);
    } catch (error) {
        res.status(500).json({ message: "Error fetching movies country" });
    }
});

app.get("/api/movies/search", async (req, res) => {
    try {
        const keyword = req.query.keyword; 
        const queryParams = req.query; 

        if (!keyword) {
            return res.status(400).json({ message: "keyword is required" });
        }
        
        const response = await axios.get(`${API_DOMAIN}/v1/api/tim-kiem`, {
            params: queryParams
        });
        
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ message: "Error fetching filtered movies", error: error.message }); 
    }
});

app.get("/api/movies/:type_list", async (req, res) => {
    try {
        const type_list = req.params.type_list;
        const queryParams = req.query;

        if (!type_list) {
            return res.status(400).json({ message: "type_list is required" });
        }
        const response = await axios.get(`${API_DOMAIN}/v1/api/danh-sach/${type_list}`, {
            params: queryParams
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ message: "Error fetching filtered movies", error: error.message }); 
    }
})


app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
    console.log(`📺 Stream endpoint: http://localhost:${PORT}/api/movie/stream`);
    console.log(`🎬 Segment endpoint: http://localhost:${PORT}/api/movie/segment`);
});