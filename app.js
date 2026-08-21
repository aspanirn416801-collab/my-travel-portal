// =========================================================================
// 公版設定：請填入您的 Google Client ID 與 GAS API URL
// =========================================================================
const GOOGLE_CLIENT_ID = "1097668023463-ibj8qn5c98mhviggncl5a9m3t7dmjc45.apps.googleusercontent.com";
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbzYvXwpdMDo5kn2TDlvSgbD2s-rXIqPMl6jn66jdWju239vRDqLoq2jcNmcD9vPNKvihA/exec";

// 前端全局狀態管理 (啟動時立即從 LocalStorage 快取中還原，實現 0.001 秒瞬間秒開！)
let idToken = localStorage.getItem("google_id_token") || null;
let userRole = localStorage.getItem("cache_userRole") || "guest"; // 'admin' | 'user' | 'guest'
let tripsList = []; // 可存取的行程列表
let currentTripUuid = "";
let tripData = null; // 當前行程詳細手冊資料
let currentTab = "checklist";
let selectedDay = 0;

// 預先同步載入本地快取
try {
  const cachedTrips = localStorage.getItem("cache_tripsList");
  if (cachedTrips) tripsList = JSON.parse(cachedTrips);
} catch (e) {}

// 初始化流程：DOMContentLoaded 立即觸發，不等網路！
document.addEventListener("DOMContentLoaded", function () {
  initRouter();
  initGoogleAuth();

  // 若當前在手冊頁，立即從快取渲染，0 秒等待！
  if (currentTripUuid) {
    try {
      const cachedTrip = localStorage.getItem("cache_trip_" + currentTripUuid);
      if (cachedTrip) {
        tripData = JSON.parse(cachedTrip);
        initCountdown();
        render();
      }
    } catch (e) {}
  } else {
    // 若在大廳頁，立即渲染大廳卡片！
    renderHubTripsGrid();
  }

  // 在背景靜默連線 Google Apps Script 同步最新數據
  fetchTrips();
});

// 監聽瀏覽器上一頁/下一頁
window.onpopstate = function () {
  initRouter();
  if (currentTripUuid) {
    fetchTripData();
  } else {
    showHubView();
    renderHubTripsGrid();
  }
};

// 解析 URL Query 參數取得行程 UUID (例如 ?trip=okayama-2027 或 ?okayama-2027)
function getTripUuidFromUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  const tripParam = urlParams.get("trip");
  if (tripParam) return tripParam.trim();

  // 支援簡短寫法 (例如 ?okayama-2027)
  const search = window.location.search.replace(/^\?/, "").trim();
  if (search && !search.includes("=")) {
    return search;
  }
  return "";
}

function initRouter() {
  currentTripUuid = getTripUuidFromUrl();
  if (currentTripUuid) {
    showTripView();
  } else {
    showHubView();
  }
}

// 路由導航切換函式
function navigateTo(tripUuid) {
  currentTripUuid = (tripUuid || "").trim();
  const currentPath = window.location.pathname;
  const newUrl = currentTripUuid
    ? `${currentPath}?trip=${encodeURIComponent(currentTripUuid)}`
    : currentPath;

  history.pushState({ trip: currentTripUuid }, "", newUrl);

  if (currentTripUuid) {
    showTripView();
    fetchTripData();
  } else {
    showHubView();
    renderHubTripsGrid();
  }
}

function showHubView() {
  document.getElementById("view-hub").style.display = "block";
  document.getElementById("view-trip").style.display = "none";
  document.getElementById("currentTripIndicator").style.display = "none";
}

function showTripView() {
  document.getElementById("view-hub").style.display = "none";
  document.getElementById("view-trip").style.display = "block";
  const indicator = document.getElementById("currentTripIndicator");
  if (indicator) {
    indicator.style.display = "inline-block";
    indicator.innerText = `📍 ${currentTripUuid}`;
  }
}

// 初始化 Google 登入元件 (無論登入與否均能運作)
function initGoogleAuth() {
  try {
    if (window.google && google.accounts && google.accounts.id) {
      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleCredentialResponse,
        auto_select: false,
        cancel_on_tap_outside: true,
      });

      // 預先在彈窗中渲染 Google 官方原生按鈕 (100% 手機相容)
      renderGsiOfficialButton();
    }
  } catch (e) {
    console.warn("Google SDK 初始化警示:", e);
  }

  updateAuthUI();
}

function renderGsiOfficialButton() {
  const container = document.getElementById("gsiButtonContainer");
  if (container && window.google && google.accounts && google.accounts.id) {
    container.innerHTML = "";
    google.accounts.id.renderButton(container, {
      theme: "outline",
      size: "large",
      type: "standard",
      shape: "pill",
      text: "signin_with",
      logo_alignment: "left",
      width: 260,
    });
  }
}

function triggerGoogleLogin() {
  const modal = document.getElementById("googleLoginModal");
  if (modal) modal.style.display = "flex";

  if (window.google && google.accounts && google.accounts.id) {
    try {
      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleCredentialResponse,
        auto_select: false,
      });

      renderGsiOfficialButton();

      // 同時嘗試喚起 One Tap 快速登入
      google.accounts.id.prompt((notification) => {
        if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
          console.log("One Tap 未直接顯示，請點選彈窗按鈕進行登入");
        }
      });
    } catch (e) {
      console.warn("GSI 觸發狀態:", e);
    }
  } else {
    alert("Google 登入服務載入中，請稍候重試。");
  }
}

function closeGoogleLoginModal() {
  const modal = document.getElementById("googleLoginModal");
  if (modal) modal.style.display = "none";
}

function updateAuthUI() {
  const badge = document.getElementById("userRoleBadge");
  const loginBtn = document.getElementById("customLoginBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const adminHubActions = document.getElementById("adminHubActions");

  if (idToken) {
    const userInfo = parseJwt(idToken);
    if (loginBtn) loginBtn.style.display = "none";
    if (logoutBtn) logoutBtn.style.display = "inline-flex";

    if (userRole === "admin") {
      badge.className = "user-badge badge-admin";
      badge.innerText = `👑 管理員 (${userInfo?.name || userInfo?.email?.split("@")[0] || ""})`;
      if (adminHubActions) adminHubActions.style.display = "block";
    } else {
      badge.className = "user-badge badge-user";
      badge.innerText = `👤 團員 (${userInfo?.name || userInfo?.email?.split("@")[0] || ""})`;
      if (adminHubActions) adminHubActions.style.display = "none";
    }
  } else {
    badge.className = "user-badge badge-guest";
    badge.innerText = "訪客模式 (唯讀)";
    if (logoutBtn) logoutBtn.style.display = "none";
    if (adminHubActions) adminHubActions.style.display = "none";
    if (loginBtn) loginBtn.style.display = "inline-flex";
  }
}

// 登入成功回呼
function handleCredentialResponse(response) {
  closeGoogleLoginModal();
  idToken = response.credential;
  localStorage.setItem("google_id_token", idToken);
  showToast("登入成功，驗證權限中...");
  fetchTrips();
}

function logout() {
  idToken = null;
  userRole = "guest";
  localStorage.removeItem("google_id_token");
  updateAuthUI();
  showToast("已成功登出");
  fetchTrips();
}

// JWT Token 解析輔助函數
function parseJwt(token) {
  try {
    const base64Url = token.split(".")[1];
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join(""),
    );
    return JSON.parse(jsonPayload);
  } catch (e) {
    return null;
  }
}

// =========================================================================
// 安全性防禦函式 (XSS 與惡意連結過濾)
// =========================================================================
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// 將各類型的 Google Drive 網址轉換為相容性最高、支援直連外嵌的格式 (lh3.googleusercontent.com)
function formatDriveImageUrl(url) {
  if (!url) return "";
  const trimmed = String(url).trim();

  const match =
    trimmed.match(/drive\.google\.com\/uc\?(?:[^"'\s]*&)?id=([a-zA-Z0-9_-]+)/i) ||
    trimmed.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i) ||
    trimmed.match(/drive\.google\.com\/open\?(?:[^"'\s]*&)?id=([a-zA-Z0-9_-]+)/i) ||
    trimmed.match(/drive\.google\.com\/thumbnail\?(?:[^"'\s]*&)?id=([a-zA-Z0-9_-]+)/i) ||
    trimmed.match(/lh3\.googleusercontent\.com\/d\/([a-zA-Z0-9_-]+)/i);

  if (match && match[1]) {
    return `https://lh3.googleusercontent.com/d/${match[1]}`;
  }
  return trimmed;
}

// 圖片載入失敗時的降級容錯處理
function handleImgError(img) {
  if (!img) return;
  const currentSrc = img.src || "";
  const match = currentSrc.match(/lh3\.googleusercontent\.com\/d\/([a-zA-Z0-9_-]+)/i);
  if (match && match[1] && !img.dataset.hasRetried) {
    img.dataset.hasRetried = "true";
    img.src = `https://drive.google.com/thumbnail?id=${match[1]}&sz=w1000`;
    return;
  }
  img.style.display = "none";
}

function sanitizeUrl(url) {
  if (!url) return "";
  const formatted = formatDriveImageUrl(url);
  const trimmed = String(formatted).trim();
  if (/^(https?:\/\/|data:image\/|blob:|\/|mailto:)/i.test(trimmed)) {
    return trimmed;
  }
  return "#";
}

// 智能目的地地名與國家封面圖庫 (支援全球中英文關鍵字自動匹配)
const DESTINATION_COVERS = [
  {
    keywords: ["okayama", "岡山", "kurashiki", "倉敷", "後樂園"],
    url: "https://images.unsplash.com/photo-1503899036084-c55cdd92da26?auto=format&fit=crop&w=1200&q=85", // 岡山城與名園
    cityTag: "🇯🇵 日本 · 岡山",
  },
  {
    keywords: ["tokyo", "東京", "shinjuku", "shibuya", "新宿", "澀谷", "銀座"],
    url: "https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?auto=format&fit=crop&w=1200&q=85", // 東京鐵塔夜景
    cityTag: "🇯🇵 日本 · 東京",
  },
  {
    keywords: ["osaka", "大阪", "dotonbori", "道頓堀", "心齋橋", "環球影城", "usj"],
    url: "https://images.unsplash.com/photo-1590559899731-a382839e5549?auto=format&fit=crop&w=1200&q=85", // 大阪城與街景
    cityTag: "🇯🇵 日本 · 大阪",
  },
  {
    keywords: ["kyoto", "京都", "gion", "祇園", "清水寺", "金閣寺", "嵐山", "arashiyama"],
    url: "https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?auto=format&fit=crop&w=1200&q=85", // 京都古都名寺
    cityTag: "🇯🇵 日本 · 京都",
  },
  {
    keywords: ["hokkaido", "北海道", "sapporo", "札幌", "otaru", "小樽", "furano", "富良野", "hakodate", "函館"],
    url: "https://images.unsplash.com/photo-1578637387939-43c525550085?auto=format&fit=crop&w=1200&q=85", // 北海道雪景
    cityTag: "🇯🇵 日本 · 北海道",
  },
  {
    keywords: ["fukuoka", "福岡", "kyushu", "九州", "kumamoto", "熊本", "oita", "由布院", "別府"],
    url: "https://images.unsplash.com/photo-1583084360699-236b28203f56?auto=format&fit=crop&w=1200&q=85", // 九州海濱
    cityTag: "🇯🇵 日本 · 九州",
  },
  {
    keywords: ["okinawa", "沖繩", "naha", "那霸", "石垣", "宮古"],
    url: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=85", // 沖繩蔚藍玻璃海
    cityTag: "🇯🇵 日本 · 沖繩",
  },
  {
    keywords: ["korea", "韓國", "seoul", "首爾", "busan", "釜山", "jeju", "濟州"],
    url: "https://images.unsplash.com/photo-1538485399081-7191377e8241?auto=format&fit=crop&w=1200&q=85", // 韓國首爾
    cityTag: "🇰🇷 韓國 · 首爾",
  },
  {
    keywords: ["europe", "歐洲", "paris", "巴黎", "france", "法國"],
    url: "https://images.unsplash.com/photo-1502602898657-3e91760cbb34?auto=format&fit=crop&w=1200&q=85", // 巴黎鐵塔
    cityTag: "🇫🇷 法國 · 巴黎",
  },
  {
    keywords: ["swiss", "瑞士", "alps", "阿爾卑斯", "zermatt", "策馬特", "interlaken"],
    url: "https://images.unsplash.com/photo-1530122037265-a5f1f91d3b99?auto=format&fit=crop&w=1200&q=85", // 瑞士雪山與湖泊
    cityTag: "🇨🇭 瑞士 · 阿爾卑斯",
  },
  {
    keywords: ["london", "倫敦", "uk", "英國", "england"],
    url: "https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?auto=format&fit=crop&w=1200&q=85", // 倫敦大笨鐘
    cityTag: "🇬🇧 英國 · 倫敦",
  },
  {
    keywords: ["thailand", "泰國", "bangkok", "曼谷", "chiangmai", "清邁", "phuket", "普吉"],
    url: "https://images.unsplash.com/photo-1508009603885-50cf7c579365?auto=format&fit=crop&w=1200&q=85", // 泰國渡假
    cityTag: "🇹🇭 泰國 · 曼谷",
  },
  {
    keywords: ["usa", "美國", "america", "nyc", "紐約", "la", "洛杉磯", "sf", "舊金山"],
    url: "https://images.unsplash.com/photo-1496442226666-8d4d0e62e6e9?auto=format&fit=crop&w=1200&q=85", // 紐約天際線
    cityTag: "🇺🇸 美國 · 紐約",
  },
  {
    keywords: ["taiwan", "台灣", "taipei", "台北", "tainan", "台南", "hualien", "花蓮", "kenting", "墾丁"],
    url: "https://images.unsplash.com/photo-1508248467877-aec1b08de376?auto=format&fit=crop&w=1200&q=85", // 台灣山城
    cityTag: "🇹🇼 台灣 · 漫遊",
  },
];

// 根據行程名稱與 UUID 智能匹配專屬城市封面照片與標籤
function getAutoCoverInfo(name = "", uuid = "", customUrl = "") {
  if (customUrl) {
    return {
      url: sanitizeUrl(customUrl),
      tag: "✈️ 行程手冊",
    };
  }

  const combined = (name + " " + uuid).toLowerCase();
  for (const item of DESTINATION_COVERS) {
    if (item.keywords.some((k) => combined.includes(k.toLowerCase()))) {
      return {
        url: item.url,
        tag: item.cityTag,
      };
    }
  }

  // 若無特定關鍵字，使用大氣的全球高空航旅封面
  return {
    url: "https://images.unsplash.com/photo-1436491865332-7a61a109cc05?auto=format&fit=crop&w=1200&q=85",
    tag: "🌍 世界漫遊",
  };
}

// 取得行程清單 (SWR 0 秒瞬間秒開快取機制)
async function fetchTrips() {
  // 1. 優先從本地快取瞬間秒開大廳，0 等待！
  try {
    const cached = localStorage.getItem("cache_tripsList");
    const cachedRole = localStorage.getItem("cache_userRole");
    if (cached) {
      tripsList = JSON.parse(cached);
      if (cachedRole) userRole = cachedRole;
      updateAuthUI();
      renderHubTripsGrid();
    }
  } catch (e) {}

  // 2. 背景向 Google 試算表靜默同步最新清單
  try {
    const tokenParam = idToken ? `&token=${encodeURIComponent(idToken)}` : "";
    const res = await fetch(`${GAS_API_URL}?action=getTrips${tokenParam}`);
    const result = await res.json();

    if (result.status === "success") {
      userRole = result.role || "guest";
      tripsList = result.trips || [];

      // 儲存至本地快取
      try {
        localStorage.setItem("cache_tripsList", JSON.stringify(tripsList));
        localStorage.setItem("cache_userRole", userRole);
      } catch (e) {}

      updateAuthUI();

      // 控制後台管理分頁是否顯示
      const isAdmin = userRole === "admin";
      const adminTabBtn = document.getElementById("btn-tab-admin");
      if (adminTabBtn) {
        adminTabBtn.style.display = isAdmin ? "block" : "none";
      }

      renderHubTripsGrid();

      // 若當前有在特定行程手冊中，更新其資料
      if (currentTripUuid) {
        fetchTripData();
      }
    }
  } catch (e) {
    console.warn("連線後端狀態:", e);
  }
}

// 渲染首頁行程大廳卡片網格 (根據目的地自動智能適配城市封面)
function renderHubTripsGrid() {
  const container = document.getElementById("hubTripsGrid");
  if (!container) return;

  if (tripsList.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:40px 10px;color:#888;grid-column:1/-1;background:var(--glass-bg);border-radius:20px;border:1.5px dashed rgba(197, 160, 89, 0.4);backdrop-filter:blur(16px);">
        <p style="font-size:14px;margin-bottom:10px;font-weight:700;color:var(--moss);">目前尚無任何公開行程</p>
        ${userRole === "admin"
        ? '<button class="glass-btn" style="background:var(--moss-gradient);color:#fff;display:inline-flex;" onclick="openCreateTripModal()">＋ 建立第一筆旅遊行程</button>'
        : '<p style="font-size:12px;color:#888;">請聯絡管理員建立行程或登入管理員帳號。</p>'
      }
      </div>
    `;
    return;
  }

  const cardsHtml = tripsList
    .map((t) => {
      const safeName = escapeHtml(t.name);
      const safeUuid = escapeHtml(t.uuid);
      const coverInfo = getAutoCoverInfo(t.name, t.uuid, t.coverUrl);

      return `
        <div class="trip-hub-card" onclick="navigateTo('${safeUuid}')">
          <div class="hub-card-cover-wrap">
            <img class="hub-card-cover" src="${coverInfo.url}" loading="lazy" referrerpolicy="no-referrer" onerror="handleImgError(this)">
            <div class="hub-card-tag">${coverInfo.tag}</div>
          </div>
          <div class="hub-card-body">
            <div>
              <div class="hub-card-title">${safeName}</div>
              <div class="hub-card-uuid">ID: ${safeUuid}</div>
              <div class="hub-card-meta">
                <div>📖 包含每日行程、航班住宿、美食口袋、代購清單</div>
              </div>
            </div>
            <div class="hub-card-btn">開啟手冊 ➔</div>
          </div>
        </div>
      `;
    })
    .join("");

  container.innerHTML = cardsHtml;
}

// 取得特定行程的詳細旅遊資料 (SWR 0 秒瞬間秒開快取機制)
async function fetchTripData() {
  if (!currentTripUuid) return;

  // 1. 優先從本地快取秒開（0.01 秒瞬間出現手冊內容，完全不用乾等轉圈圈！）
  let hasCache = false;
  try {
    const cached = localStorage.getItem("cache_trip_" + currentTripUuid);
    if (cached) {
      tripData = JSON.parse(cached);
      hasCache = true;
      const indicator = document.getElementById("currentTripIndicator");
      if (indicator) {
        indicator.style.display = "inline-block";
        indicator.innerText = `📍 ${tripData.name || currentTripUuid}`;
      }
      initCountdown();
      render();
    }
  } catch (e) {}

  // 若完全無快取（首次造訪該行程），才顯示載入提示
  if (!hasCache) {
    showLoading("正在載入手冊資料，請稍候...");
  }

  // 2. 在背景向 Google 試算表靜默同步最新修改
  try {
    const tokenParam = idToken ? `&token=${encodeURIComponent(idToken)}` : "";
    const res = await fetch(
      `${GAS_API_URL}?action=getTripData&tripUuid=${encodeURIComponent(
        currentTripUuid,
      )}${tokenParam}`,
    );
    const result = await res.json();
    if (result.status === "success") {
      tripData = result.data;
      if (result.role) userRole = result.role;

      // 儲存至本地快取
      try {
        localStorage.setItem("cache_trip_" + currentTripUuid, JSON.stringify(tripData));
      } catch (e) {}

      updateAuthUI();

      const indicator = document.getElementById("currentTripIndicator");
      if (indicator) {
        indicator.style.display = "inline-block";
        indicator.innerText = `📍 ${tripData.name || currentTripUuid}`;
      }

      initCountdown();
      render();
      if (hasCache) {
        showToast("手冊資料已同步最新 ✓");
      }
    }
  } catch (e) {
    console.warn("背景同步失敗:", e);
  } finally {
    hideLoading();
  }
}

// 計算出發倒數並更新 Hero 封面資訊與背景照片 (智能適配目的地封面)
function initCountdown() {
  if (!tripData || !tripData.startDate) {
    document.getElementById("tripCountdown").innerText = "尚未設定日期";
    return;
  }
  const targetDate = new Date(tripData.startDate + "T00:00:00");
  const now = new Date();
  const diffTime = targetDate - now;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  const cdEl = document.getElementById("tripCountdown");

  if (diffDays > 0) {
    cdEl.innerText = `距離出發還有 ${diffDays} 天`;
  } else if (diffDays === 0) {
    cdEl.innerText = `✨ 旅程就是今天！`;
  } else {
    cdEl.innerText = `旅程進行中 / 已出發`;
  }

  // 更新 Hero 區域文字
  document.getElementById("portalTitle").innerText =
    `✈️ ${tripData.name || "旅遊行程手冊"}`;
  document.getElementById("portalSubtitle").innerText =
    `${tripData.startDate || ""} — ${tripData.endDate || ""}・${tripData.duration || ""
    }`;

  // 智能匹配或使用自訂封面更換 Hero 背景
  const heroEl = document.querySelector("#view-trip .hero");
  if (heroEl) {
    const coverInfo = getAutoCoverInfo(tripData.name, currentTripUuid, tripData.coverUrl);
    heroEl.style.backgroundImage = `linear-gradient(180deg, rgba(15, 28, 18, 0.3) 0%, rgba(15, 28, 18, 0.85) 80%, rgba(15, 28, 18, 0.95) 100%), url('${coverInfo.url}')`;
  }
}

function showToast(text) {
  const t = document.getElementById("toast");
  t.innerText = text;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

// 全域 Loading 轉圈遮罩控制
function showLoading(text = "資料同步中，請稍候...") {
  const loader = document.getElementById("globalLoading");
  const txt = document.getElementById("loadingText");
  if (txt) txt.innerText = text;
  if (loader) loader.style.display = "flex";
}

function hideLoading() {
  const loader = document.getElementById("globalLoading");
  if (loader) loader.style.display = "none";
}

// 即時單筆同步儲存至 Google 試算表（並立即更新本地快取確保 0 秒秒開）
async function save() {
  // 立即寫入本地快取，保證下次開啟瞬間秒開
  try {
    if (currentTripUuid && tripData) {
      localStorage.setItem("cache_trip_" + currentTripUuid, JSON.stringify(tripData));
    }
  } catch (e) {}

  if (userRole === "admin") {
    showToast("正在同步至雲端試算表...");
    try {
      const res = await fetch(`${GAS_API_URL}`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=utf-8",
        },
        body: JSON.stringify({
          action: "updateTripData",
          token: idToken,
          tripUuid: currentTripUuid,
          data: tripData,
        }),
      });
      const result = await res.json();
      if (result.status === "success") {
        showToast("雲端同步成功 ✓");
        return true;
      } else {
        showToast(result.message || "雲端儲存失敗");
        return false;
      }
    } catch (e) {
      showToast("已暫存於本機（離線保護）");
      return false;
    }
  } else {
    showToast("訪客模式：已暫存於本機");
    return true;
  }
}

function uid() {
  return Math.random().toString(36).slice(2, 8);
}

function switchTab(id, btn) {
  currentTab = id;
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.remove("active"));
  document
    .querySelectorAll(".tab-btn")
    .forEach((b) => b.classList.remove("active"));
  document.getElementById("page-" + id).classList.add("active");
  btn.classList.add("active");
  render();
}

function setFont(size, btn) {
  document
    .querySelectorAll(".font-btn")
    .forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  document.body.classList.toggle("large", size === "large");
}

// === 通用互動對話框 (Modal) 管理函式 ===
let modalConfirmHandler = null;

function openConfirmModal({
  title = "操作確認",
  message = "確定要執行此操作嗎？",
  confirmText = "確定",
  danger = false,
  onConfirm,
}) {
  document.getElementById("modalTitle").innerText = title;
  document.getElementById("modalBody").innerHTML =
    `<p style="font-size:14px;line-height:1.6;">${message}</p>`;
  const confirmBtn = document.getElementById("modalConfirmBtn");
  confirmBtn.innerText = confirmText;
  confirmBtn.className = `modal-btn modal-btn-confirm ${danger ? "modal-btn-danger" : ""
    }`;

  modalConfirmHandler = () => {
    closeModal();
    if (typeof onConfirm === "function") onConfirm();
  };

  confirmBtn.onclick = modalConfirmHandler;
  document.getElementById("commonModal").style.display = "flex";
}

function openFormModal({
  title = "填寫資料",
  bodyHtml = "",
  confirmText = "確定儲存",
  onConfirm,
}) {
  document.getElementById("modalTitle").innerText = title;
  document.getElementById("modalBody").innerHTML = bodyHtml;
  const confirmBtn = document.getElementById("modalConfirmBtn");
  confirmBtn.innerText = confirmText;
  confirmBtn.className = "modal-btn modal-btn-confirm";

  modalConfirmHandler = () => {
    if (typeof onConfirm === "function") {
      const isValid = onConfirm();
      if (isValid !== false) {
        closeModal();
      }
    } else {
      closeModal();
    }
  };

  confirmBtn.onclick = modalConfirmHandler;
  document.getElementById("commonModal").style.display = "flex";
}

function closeModal() {
  document.getElementById("commonModal").style.display = "none";
  modalConfirmHandler = null;
}

// =========================================================================
// 1. 必備清單 (Checklist) - 現代輕奢進度儀表板與即時同步
// =========================================================================
function renderChecklist() {
  if (!tripData) return;
  const list = tripData.checklist || [];
  const isAdmin = userRole === "admin";

  const doneCount = list.filter((i) => i.done).length;
  const percent = list.length ? Math.round((doneCount / list.length) * 100) : 0;

  const rows = list
    .map((item, i) => {
      const adminActions = isAdmin
        ? `<div class="item-actions">
             <button class="btn-mini" onclick="editChecklistItem(${i})">✏️ 修改</button>
             <button class="btn-mini btn-mini-danger" onclick="deleteChecklistItem(${i})">🗑️ 刪除</button>
           </div>`
        : "";

      const safeCat = escapeHtml(item.cat || "備忘");
      const safeTitle = escapeHtml(item.title || "");
      const safeNote = escapeHtml(item.note || "");
      const safeLink = sanitizeUrl(item.link);

      return `
        <div style="display:flex;align-items:flex-start;gap:14px;padding:14px 0;border-bottom:1px solid rgba(220, 226, 222, 0.45);transition:all 0.2s;">
          <input type="checkbox" style="width:20px;height:20px;accent-color:var(--moss);margin-top:2px;cursor:pointer;border-radius:6px;" ${item.done ? "checked" : ""
        } onclick="toggleChecklistItem(${i})">
          <div style="flex:1;${item.done ? "text-decoration:line-through;opacity:0.45;" : ""
        }">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:10px;font-weight:800;color:#6B5A2A;background:var(--gold-soft);padding:3px 9px;border-radius:8px;letter-spacing:0.5px;border:1px solid rgba(197, 160, 89, 0.3);">${safeCat
        }</span>
              ${adminActions}
            </div>
            <div style="font-size:15px;font-weight:800;color:var(--moss);margin-top:5px;">${safeTitle
        }</div>
            ${safeNote
          ? `<div style="font-size:12px;color:#666;margin-top:3px;line-height:1.5;">${safeNote}</div>`
          : ""
        }
            ${safeLink && safeLink !== "#"
          ? `<a class="ext-link" href="${safeLink}" target="_blank" rel="noopener noreferrer">🔗 點擊查看/預約</a>`
          : ""
        }
          </div>
        </div>
      `;
    })
    .join("");

  const addBtn = isAdmin
    ? `<button class="glass-btn" style="background:var(--moss-gradient);color:#fff;width:100%;margin-top:16px;justify-content:center;" onclick="openAddChecklistModal()">＋ 新增必備項目</button>`
    : "";

  document.getElementById("page-checklist").innerHTML = `
    <!-- 輕奢進度儀表板 -->
    <div class="card" style="background:var(--moss-gradient);color:#FFF;border:none;box-shadow:0 14px 36px rgba(31,54,36,0.25);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div>
          <div style="font-size:11px;color:rgba(255,255,255,0.8);letter-spacing:1.5px;font-weight:800;">PREPARATION PROGRESS</div>
          <div style="font-family:'Noto Serif TC',serif;font-size:22px;font-weight:900;margin-top:2px;">行前準備進度 · ${percent}%</div>
        </div>
        <div style="background:rgba(255,255,255,0.18);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.35);border-radius:14px;padding:6px 14px;font-size:13px;font-weight:800;">
          ${doneCount} / ${list.length} 完成
        </div>
      </div>
      <div style="width:100%;height:8px;background:rgba(255,255,255,0.22);border-radius:10px;overflow:hidden;">
        <div style="width:${percent}%;height:100%;background:linear-gradient(90deg, #DFC17B, #FFF);border-radius:10px;transition:width 0.4s ease;"></div>
      </div>
    </div>

    <!-- 清單內容卡片 -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">✓ 行前準備清單項目</span>
      </div>
      ${rows || '<p style="color:#888;">尚無清單項目</p>'}
      ${addBtn}
    </div>
  `;
}

function toggleChecklistItem(index) {
  tripData.checklist[index].done = !tripData.checklist[index].done;
  save();
  renderChecklist();
}

function editChecklistItem(index) {
  const item = tripData.checklist[index];
  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">類別標籤</div>
      <input type="text" id="editChecklistCat" class="ef-input" value="${item.cat || ""}">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">項目名稱 <span style="color:var(--red);">*</span></div>
      <input type="text" id="editChecklistTitle" class="ef-input" value="${item.title || ""}">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">備註說明</div>
      <input type="text" id="editChecklistNote" class="ef-input" value="${item.note || ""}">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">外部連結</div>
      <input type="text" id="editChecklistLink" class="ef-input" value="${item.link || ""}">
    </div>
  `;

  openFormModal({
    title: "✏️ 編輯必備清單項目",
    bodyHtml: formHtml,
    confirmText: "儲存修改",
    onConfirm: () => {
      const cat = document.getElementById("editChecklistCat").value.trim();
      const title = document.getElementById("editChecklistTitle").value.trim();
      const note = document.getElementById("editChecklistNote").value.trim();
      const link = document.getElementById("editChecklistLink").value.trim();

      if (!title) {
        alert("項目名稱不得為空！");
        return false;
      }

      tripData.checklist[index].cat = cat || "備忘";
      tripData.checklist[index].title = title;
      tripData.checklist[index].note = note;
      tripData.checklist[index].link = link;

      renderChecklist();
      save();
      return true;
    },
  });
}

function deleteChecklistItem(index) {
  const item = tripData.checklist[index];
  openConfirmModal({
    title: "刪除必備項目確認",
    message: `確定要刪除「${item.title || "此項目"}」嗎？`,
    danger: true,
    confirmText: "確定刪除",
    onConfirm: () => {
      tripData.checklist.splice(index, 1);
      renderChecklist();
      save();
    },
  });
}

function openAddChecklistModal() {
  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">類別標籤（如：證件票券、電器裝備、隨身衣物）</div>
      <input type="text" id="addChecklistCat" class="ef-input" value="行前準備">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">項目名稱 <span style="color:var(--red);">*</span></div>
      <input type="text" id="addChecklistTitle" class="ef-input" placeholder="例如: 護照正本、日幣現金">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">備註說明</div>
      <input type="text" id="addChecklistNote" class="ef-input" placeholder="例如: 檢查效期需超過6個月">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">相關連結 (可留空)</div>
      <input type="text" id="addChecklistLink" class="ef-input" placeholder="https://...">
    </div>
  `;

  openFormModal({
    title: "➕ 新增必備清單項目",
    bodyHtml: formHtml,
    confirmText: "確認新增並同步",
    onConfirm: () => {
      const cat = document.getElementById("addChecklistCat").value.trim();
      const title = document.getElementById("addChecklistTitle").value.trim();
      const note = document.getElementById("addChecklistNote").value.trim();
      const link = document.getElementById("addChecklistLink").value.trim();

      if (!title) {
        alert("請輸入項目名稱！");
        return false;
      }

      if (!tripData.checklist) tripData.checklist = [];
      tripData.checklist.push({
        id: uid(),
        cat: cat || "備忘",
        title: title,
        note: note,
        link: link,
        done: false,
      });

      renderChecklist();
      save();
      return true;
    },
  });
}

// =========================================================================
// 2. 航班與住宿 (Flights & Hotel) - 專屬表單與即時同步
// =========================================================================
function renderFlights() {
  if (!tripData) return;
  const isAdmin = userRole === "admin";

  function fc(title, f, type) {
    if (!f) f = {};
    const editBtn = isAdmin
      ? `<button class="card-header-btn" onclick="openEditFlightModal('${type}')">✏️ 編輯</button>`
      : "";

    const airline = escapeHtml(f.airline || "航空公司");
    const flightNo = escapeHtml(f.no || "航班待定");
    const fromCity = escapeHtml(f.from || "出發地");
    const toCity = escapeHtml(f.to || "目的地");
    const depTime = escapeHtml(f.dep || "--:--");
    const arrTime = escapeHtml(f.arr || "--:--");
    const flightDate = escapeHtml(f.date || "未設定日期");
    const flightNote = escapeHtml(f.note || "");

    return `
      <div class="boarding-pass">
        <!-- 登機證頂部標頭 -->
        <div class="bp-header">
          <div class="bp-airline-tag">
            <span>✈️</span>
            <span>${airline}</span>
            <span style="font-size:11px;color:#888;margin-left:4px;">· ${title}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="bp-flight-no">${flightNo}</span>
            ${editBtn}
          </div>
        </div>

        <!-- 登機證核心起降資訊 -->
        <div class="bp-body">
          <div style="text-align:left;">
            <div class="bp-airport-code">${fromCity}</div>
            <div class="bp-city">DEPARTURE</div>
            <div class="bp-time">${depTime}</div>
          </div>

          <div class="bp-route-line">
            <div class="bp-route-plane">✈️</div>
            <div class="bp-route-bar"></div>
            <div class="bp-date-pill">📅 ${flightDate}</div>
          </div>

          <div style="text-align:right;">
            <div class="bp-airport-code">${toCity}</div>
            <div class="bp-city">ARRIVAL</div>
            <div class="bp-time">${arrTime}</div>
          </div>
        </div>

        <!-- 實體登機證撕裂線與缺口 -->
        <div class="bp-divider">
          <div class="bp-notch-left"></div>
          <div class="bp-notch-right"></div>
        </div>

        <!-- 登機證底部條碼與備註 -->
        <div class="bp-footer">
          <div class="bp-barcode">||| | |||| || ||||| | |||</div>
          <div style="font-size:11px;color:${flightNote ? 'var(--red)' : '#888'};font-weight:700;">
            ${flightNote ? `⚠️ ${flightNote}` : "BOARDING PASS · TRAVEL PORTAL"}
          </div>
        </div>
      </div>
    `;
  }

  // 自動計算晚數輔助函式
  function calcNights(checkin, checkout, manualNights) {
    if (checkin && checkout) {
      const d1 = new Date(checkin + "T00:00:00");
      const d2 = new Date(checkout + "T00:00:00");
      const diffTime = d2 - d1;
      const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
      if (diffDays > 0) return `${diffDays}晚`;
    }
    if (manualNights && manualNights.toString().trim()) {
      const str = manualNights.toString().trim();
      return str.includes("晚") ? str : `${str}晚`;
    }
    return "";
  }

  // 飯店住宿清單渲染 (支援多筆飯店住宿)
  const hotels =
    tripData.hotels ||
    (tripData.hotel && tripData.hotel.name ? [tripData.hotel] : []);

  const addHotelBtn = isAdmin
    ? `<button class="glass-btn" style="background:var(--moss-gradient);color:#fff;width:100%;margin-top:14px;justify-content:center;" onclick="openAddHotelModal()">＋ 新增飯店住宿</button>`
    : "";

  const hotelCards =
    hotels.length > 0
      ? hotels
        .map((h, idx) => {
          const hotelQuery = encodeURIComponent(
            (h.name || "") + " " + (h.addr || ""),
          );
          const hotelMapUrl =
            h.name || h.addr
              ? "https://www.google.com/maps/search/?api=1&query=" +
              hotelQuery
              : "";

          const adminActions = isAdmin
            ? `<div class="item-actions">
                   <button class="btn-mini" onclick="openEditHotelModal(${idx})">✏️ 修改</button>
                   <button class="btn-mini btn-mini-danger" onclick="deleteHotel(${idx})">🗑️ 刪除</button>
                 </div>`
            : "";

          const nightsStr = calcNights(h.checkin, h.checkout, h.nights);
          const dateLine =
            h.checkin || h.checkout
              ? `📅 ${h.checkin || "未設定"} ～ ${h.checkout || "未設定"}${nightsStr ? `（${nightsStr}）` : ""
              }`
              : `📅 尚未設定住宿日期`;

          const safeName = escapeHtml(h.name || "未命名飯店");
          const safeAddr = escapeHtml(h.addr || "尚未填寫地址");
          const safeNote = escapeHtml(h.note || "");
          const safeDateLine = escapeHtml(dateLine);

          return `
              <div class="hotel-card">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                  <div class="hotel-name">🏨 ${safeName}</div>
                  ${adminActions}
                </div>
                <div class="hotel-meta">📍 ${safeAddr}</div>
                <div class="hotel-meta">${safeDateLine}</div>
                ${safeNote
              ? `<div style="font-size:12px;color:#6B5A2A;background:var(--gold-soft);padding:8px 12px;border-radius:10px;margin:10px 0;border:1px dashed rgba(197, 160, 89, 0.4);">💡 ${safeNote}</div>`
              : ""
            }
                ${hotelMapUrl
              ? `<a class="map-link" style="margin-top:10px;" href="${hotelMapUrl}" target="_blank" rel="noopener noreferrer">🗺 Google 地圖導航</a>`
              : ""
            }
              </div>
            `;
        })
        .join("")
      : '<p style="color:#888;">尚未設定飯店住宿資訊</p>';

  document.getElementById("page-flights").innerHTML = `
    <div style="margin-bottom: 24px;">
      <div style="font-family:'Noto Serif TC',serif;font-size:17px;font-weight:900;color:var(--moss);margin-bottom:14px;display:flex;align-items:center;gap:6px;">
        <span>✈️ 機票行程（登機證）</span>
      </div>
      ${fc("去程航班", tripData.flights ? tripData.flights.out : {}, "out")}
      ${fc("回程航班", tripData.flights ? tripData.flights.in : {}, "in")}
    </div>
    <div class="card">
      <div class="card-header">
        <span class="card-title">🏨 飯店住宿清單</span>
      </div>
      ${hotelCards}
      ${addHotelBtn}
    </div>
  `;
}

function openEditFlightModal(type) {
  if (!tripData.flights) tripData.flights = { out: {}, in: {} };
  const f = tripData.flights[type] || {};
  const title = type === "out" ? "去程航班" : "回程航班";

  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">航空公司</div>
      <input type="text" id="editFlightAirline" class="ef-input" value="${f.airline || ""}">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">航班編號 (例如: IT214)</div>
      <input type="text" id="editFlightNo" class="ef-input" value="${f.no || ""}">
    </div>
    <div style="display:flex;gap:10px;">
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">出發地</div>
        <input type="text" id="editFlightFrom" class="ef-input" value="${f.from || ""}">
      </div>
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">目的地</div>
        <input type="text" id="editFlightTo" class="ef-input" value="${f.to || ""}">
      </div>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">搭乘日期</div>
      <input type="date" id="editFlightDate" class="ef-input" value="${f.date || ""}">
    </div>
    <div style="display:flex;gap:10px;">
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">出發時間</div>
        <input type="text" id="editFlightDep" class="ef-input" placeholder="例如: 11:30" value="${f.dep || ""}">
      </div>
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">抵達時間</div>
        <input type="text" id="editFlightArr" class="ef-input" placeholder="例如: 15:05" value="${f.arr || ""}">
      </div>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">備註說明</div>
      <input type="text" id="editFlightNote" class="ef-input" placeholder="例如: 第1航廈、準時登機" value="${f.note || ""}">
    </div>
  `;

  openFormModal({
    title: `✏️ 編輯 ${title}`,
    bodyHtml: formHtml,
    confirmText: "儲存航班並同步",
    onConfirm: () => {
      tripData.flights[type] = {
        airline: document.getElementById("editFlightAirline").value.trim(),
        no: document.getElementById("editFlightNo").value.trim(),
        from: document.getElementById("editFlightFrom").value.trim(),
        to: document.getElementById("editFlightTo").value.trim(),
        date: document.getElementById("editFlightDate").value.trim(),
        dep: document.getElementById("editFlightDep").value.trim(),
        arr: document.getElementById("editFlightArr").value.trim(),
        note: document.getElementById("editFlightNote").value.trim(),
      };
      renderFlights();
      save();
      return true;
    },
  });
}

function autoSyncNights(inId, outId, nightsId) {
  const inVal = document.getElementById(inId).value;
  const outVal = document.getElementById(outId).value;
  if (inVal && outVal) {
    const d1 = new Date(inVal + "T00:00:00");
    const d2 = new Date(outVal + "T00:00:00");
    const diffDays = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
    if (diffDays > 0) {
      document.getElementById(nightsId).value = `${diffDays}晚`;
    }
  }
}

function openAddHotelModal() {
  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">飯店名稱 <span style="color:var(--red);">*</span></div>
      <input type="text" id="addHotelName" class="ef-input" placeholder="例如: 岡山格蘭比亞大酒店">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">飯店地址 (供 Google 導航使用)</div>
      <input type="text" id="addHotelAddr" class="ef-input" placeholder="例如: 〒700-0024 岡山県岡山市北区駅元町1-5">
    </div>
    <div style="display:flex;gap:10px;">
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">入住日</div>
        <input type="date" id="addHotelCheckin" class="ef-input" onchange="autoSyncNights('addHotelCheckin','addHotelCheckout','addHotelNights')">
      </div>
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">退房日</div>
        <input type="date" id="addHotelCheckout" class="ef-input" onchange="autoSyncNights('addHotelCheckin','addHotelCheckout','addHotelNights')">
      </div>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">晚數說明 (自動計算，亦可手動修改)</div>
      <input type="text" id="addHotelNights" class="ef-input" placeholder="例如: 3晚">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">備註說明</div>
      <input type="text" id="addHotelNote" class="ef-input" placeholder="例如: 岡山站直結、已含早餐、可寄放行李">
    </div>
  `;

  openFormModal({
    title: "➕ 新增飯店住宿",
    bodyHtml: formHtml,
    confirmText: "確認新增並同步",
    onConfirm: () => {
      const name = document.getElementById("addHotelName").value.trim();
      if (!name) {
        alert("請輸入飯店名稱！");
        return false;
      }

      if (!tripData.hotels) {
        tripData.hotels =
          tripData.hotel && tripData.hotel.name ? [tripData.hotel] : [];
      }

      const inDate = document.getElementById("addHotelCheckin").value.trim();
      const outDate = document.getElementById("addHotelCheckout").value.trim();
      let nights = document.getElementById("addHotelNights").value.trim();

      // 若未填寫晚數但有選擇日期，自動計算
      if (!nights && inDate && outDate) {
        const d1 = new Date(inDate + "T00:00:00");
        const d2 = new Date(outDate + "T00:00:00");
        const diff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
        if (diff > 0) nights = `${diff}晚`;
      }

      tripData.hotels.push({
        id: uid(),
        name: name,
        addr: document.getElementById("addHotelAddr").value.trim(),
        checkin: inDate,
        checkout: outDate,
        nights: nights,
        note: document.getElementById("addHotelNote").value.trim(),
      });

      renderFlights();
      save();
      return true;
    },
  });
}

function openEditHotelModal(index) {
  const hotels =
    tripData.hotels ||
    (tripData.hotel && tripData.hotel.name ? [tripData.hotel] : []);
  const h = hotels[index] || {};

  // 若晚數未填或未格式化，預先計算
  let currentNights = h.nights || "";
  if (!currentNights && h.checkin && h.checkout) {
    const d1 = new Date(h.checkin + "T00:00:00");
    const d2 = new Date(h.checkout + "T00:00:00");
    const diff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
    if (diff > 0) currentNights = `${diff}晚`;
  }

  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">飯店名稱 <span style="color:var(--red);">*</span></div>
      <input type="text" id="editHotelName" class="ef-input" value="${h.name || ""
    }">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">飯店地址 (供導航使用)</div>
      <input type="text" id="editHotelAddr" class="ef-input" value="${h.addr || ""
    }">
    </div>
    <div style="display:flex;gap:10px;">
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">入住日</div>
        <input type="date" id="editHotelCheckin" class="ef-input" value="${h.checkin || ""
    }" onchange="autoSyncNights('editHotelCheckin','editHotelCheckout','editHotelNights')">
      </div>
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">退房日</div>
        <input type="date" id="editHotelCheckout" class="ef-input" value="${h.checkout || ""
    }" onchange="autoSyncNights('editHotelCheckin','editHotelCheckout','editHotelNights')">
      </div>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">晚數說明 (自動計算，亦可手動修改)</div>
      <input type="text" id="editHotelNights" class="ef-input" value="${currentNights}">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">備註說明</div>
      <input type="text" id="editHotelNote" class="ef-input" placeholder="例如: 岡山站直結、附早餐" value="${h.note || ""
    }">
    </div>
  `;

  openFormModal({
    title: "✏️ 編輯飯店住宿資訊",
    bodyHtml: formHtml,
    confirmText: "儲存修改並同步",
    onConfirm: () => {
      const name = document.getElementById("editHotelName").value.trim();
      if (!name) {
        alert("請填寫飯店名稱！");
        return false;
      }

      if (!tripData.hotels) {
        tripData.hotels =
          tripData.hotel && tripData.hotel.name ? [tripData.hotel] : [];
      }

      const inDate = document.getElementById("editHotelCheckin").value.trim();
      const outDate = document.getElementById("editHotelCheckout").value.trim();
      let nights = document.getElementById("editHotelNights").value.trim();

      if (!nights && inDate && outDate) {
        const d1 = new Date(inDate + "T00:00:00");
        const d2 = new Date(outDate + "T00:00:00");
        const diff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
        if (diff > 0) nights = `${diff}晚`;
      }

      tripData.hotels[index] = {
        name: name,
        addr: document.getElementById("editHotelAddr").value.trim(),
        checkin: inDate,
        checkout: outDate,
        nights: nights,
        note: document.getElementById("editHotelNote").value.trim(),
      };

      renderFlights();
      save();
      return true;
    },
  });
}

function deleteHotel(index) {
  const hotels =
    tripData.hotels ||
    (tripData.hotel && tripData.hotel.name ? [tripData.hotel] : []);
  const h = hotels[index];

  openConfirmModal({
    title: "刪除飯店確認",
    message: `確定要刪除飯店「${h.name || "此住宿"}」嗎？`,
    danger: true,
    confirmText: "確定刪除",
    onConfirm: () => {
      if (!tripData.hotels) {
        tripData.hotels =
          tripData.hotel && tripData.hotel.name ? [tripData.hotel] : [];
      }
      tripData.hotels.splice(index, 1);
      renderFlights();
      save();
    },
  });
}

// 輔助函式：清洗試算表可能回傳的 1899 異常年份時間格式，還原為乾淨時間 (如 14:00)
function cleanTimeDisplay(t) {
  if (!t) return "行程";
  const str = t.toString().trim();
  if (
    str.includes("1899") ||
    str.includes("1900") ||
    (str.includes("T") && str.includes("Z"))
  ) {
    // 優先使用正則表達式擷取裡面的 HH:mm (例如 14:00:00 擷取出 14:00)
    const timeMatch = str.match(/(\d{1,2}:\d{2})(?::\d{2})?/);
    if (timeMatch) {
      return timeMatch[1];
    }
    try {
      const d = new Date(str);
      if (!isNaN(d.getTime())) {
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        return `${hh}:${mm}`;
      }
    } catch (e) { }
  }
  return str || "行程";
}

// =========================================================================
// 3. 每日行程 (Itinerary) - 景點單筆微編輯與即時同步
// =========================================================================
function renderItinerary() {
  if (!tripData || !tripData.days || tripData.days.length === 0) {
    const emptyHtml = `
      <div class="card" style="text-align:center;padding:36px 16px;">
        <p style="color:#888;margin-bottom:14px;font-size:14px;font-weight:700;">目前尚未建立任何行程天數</p>
        ${userRole === "admin"
        ? `<button class="glass-btn" style="background:var(--moss-gradient);color:#fff;display:inline-flex;" onclick="openAddDayModal()">＋ 建立 Day 1 行程</button>`
        : ""
      }
      </div>
    `;
    document.getElementById("page-itinerary").innerHTML = emptyHtml;
    return;
  }

  if (selectedDay >= tripData.days.length) {
    selectedDay = tripData.days.length - 1;
  }
  if (selectedDay < 0) selectedDay = 0;

  const isAdmin = userRole === "admin";

  // 天數切換按鈕列表
  const dayBtns = tripData.days
    .map((d, i) => {
      const dateText = (d.date || "")
        .split("（")[0]
        .replace("月", "/")
        .replace("日", "")
        .trim();
      return `
        <button class="day-btn ${i === selectedDay ? "active" : ""}" onclick="selectedDay=${i};renderItinerary()">
          <span class="day-btn-date">${dateText || `第 ${i + 1} 天`}</span>
          <span class="day-btn-id">${d.id}</span>
        </button>
      `;
    })
    .join("");

  const addDayBtn = isAdmin
    ? `<button class="day-add-btn" onclick="openAddDayModal()">＋ 新增天數</button>`
    : "";

  const day = tripData.days[selectedDay] || tripData.days[0];
  if (!day) return;

  const dayActions = isAdmin
    ? `<div class="item-actions">
         <button class="btn-mini" onclick="openEditDayTitleModal(${selectedDay})">✏️ 編輯主題</button>
         ${tripData.days.length > 1
      ? `<button class="btn-mini btn-mini-danger" onclick="deleteCurrentDay(${selectedDay})">🗑️ 刪除本日</button>`
      : ""
    }
       </div>`
    : "";

  const items = (day.items || [])
    .map((item, j) => {
      const mapQuery = encodeURIComponent(item.place || "");
      const autoMapUrl = item.place
        ? "https://www.google.com/maps/search/?api=1&query=" + mapQuery
        : "";

      const adminActions = isAdmin
        ? `<div class="item-actions">
             <button class="btn-mini" onclick="openEditItineraryModal(${selectedDay}, ${j})">✏️ 修改</button>
             <button class="btn-mini btn-mini-danger" onclick="deleteItineraryItem(${selectedDay}, ${j})">🗑️ 刪除</button>
           </div>`
        : "";

      const displayTime = cleanTimeDisplay(item.time);
      const safePlace = escapeHtml(item.place || "未命名景點");
      const safeDesc = escapeHtml(item.desc || "");
      const safeImgUrl = sanitizeUrl(item.imgUrl);

      return `
        <div class="tl">
          <div class="tl-time-badge">${displayTime}</div>
          <div class="tl-content">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;">
              <div class="tl-place">${safePlace}</div>
              ${adminActions}
            </div>
            ${safeDesc ? `<div class="tl-desc">${safeDesc}</div>` : ""}
            ${safeImgUrl && safeImgUrl !== "#"
          ? `<div style="margin-top:10px;"><img src="${safeImgUrl}" referrerpolicy="no-referrer" loading="lazy" style="max-width:100%;max-height:220px;border-radius:14px;box-shadow:0 4px 14px rgba(0,0,0,0.08);display:block;object-fit:cover;border:1px solid rgba(255,255,255,0.8);" onerror="handleImgError(this)"></div>`
          : ""
        }
            ${autoMapUrl
          ? `<a class="map-link" href="${autoMapUrl}" target="_blank" rel="noopener noreferrer">🗺 地圖導航</a>`
          : ""
        }
          </div>
        </div>
      `;
    })
    .join("");

  const addBtn = isAdmin
    ? `<button class="glass-btn" style="background:var(--moss-gradient);color:#fff;width:100%;margin-top:16px;justify-content:center;" onclick="openAddItineraryModal(${selectedDay})">＋ 新增景點</button>`
    : "";

  document.getElementById("page-itinerary").innerHTML = `
    <div class="day-selector">
      ${dayBtns}
      ${addDayBtn}
    </div>
    <div class="card">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <span class="card-title">${day.id} ｜ ${day.title || "未設定主題"}</span>
          <div style="font-size:12px;color:var(--gold);font-weight:700;margin-top:2px;">📅 ${day.date || ""}</div>
        </div>
        ${dayActions}
      </div>
      <div class="timeline">${items ||
    '<p style="color:#888;font-size:13px;padding:10px 0;">本日尚無規劃景點，請點擊下方按鈕新增！</p>'
    }</div>
      ${addBtn}
    </div>
  `;
}

// 新增行程天數對話框
function openAddDayModal() {
  if (!tripData.days) tripData.days = [];
  const nextDayNum = tripData.days.length + 1;
  const nextDayId = `Day ${nextDayNum}`;

  // 嘗試推算下一天日期
  let defaultDateText = "";
  if (tripData.startDate) {
    const base = new Date(tripData.startDate + "T00:00:00");
    base.setDate(base.getDate() + (nextDayNum - 1));
    const m = base.getMonth() + 1;
    const d = base.getDate();
    const dayNames = ["日", "一", "二", "三", "四", "五", "六"];
    const w = dayNames[base.getDay()];
    defaultDateText = `${m}月${d}日（${w}）`;
  }

  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">天數識別 (例如: Day ${nextDayNum}) <span style="color:var(--red);">*</span></div>
      <input type="text" id="addDayId" class="ef-input" value="${nextDayId}">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">日期文字說明 (例如: 10月5日（日）)</div>
      <input type="text" id="addDayDate" class="ef-input" value="${defaultDateText}" placeholder="例如: 10月5日（日）">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">當日行程主題名稱 <span style="color:var(--red);">*</span></div>
      <input type="text" id="addDayTitle" class="ef-input" placeholder="例如: 岡山城 ＆ 後樂園漫遊">
    </div>
  `;

  openFormModal({
    title: `➕ 新增 ${nextDayId} 行程天數`,
    bodyHtml: formHtml,
    confirmText: "確認新增並同步",
    onConfirm: () => {
      const dayId =
        document.getElementById("addDayId").value.trim() || nextDayId;
      const title = document.getElementById("addDayTitle").value.trim();
      const date = document.getElementById("addDayDate").value.trim();

      if (!title) {
        alert("請輸入當日行程主題名稱！");
        return false;
      }

      tripData.days.push({
        id: dayId,
        date: date,
        title: title,
        items: [],
      });

      selectedDay = tripData.days.length - 1;
      renderItinerary();
      save();
      return true;
    },
  });
}

// 刪除指定天數
function deleteCurrentDay(dayIdx) {
  const day = tripData.days[dayIdx];
  if (!day) return;

  openConfirmModal({
    title: "刪除行程天數確認",
    message: `確定要刪除「${day.id} ｜ ${day.title}」及其包含的所有景點活動嗎？此操作不可逆！`,
    danger: true,
    confirmText: "確定刪除本日",
    onConfirm: () => {
      tripData.days.splice(dayIdx, 1);
      if (selectedDay >= tripData.days.length) {
        selectedDay = Math.max(0, tripData.days.length - 1);
      }
      renderItinerary();
      save();
    },
  });
}

function openEditDayTitleModal(dayIdx) {
  const day = tripData.days[dayIdx];
  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">天數識別 (例如: Day 1)</div>
      <input type="text" id="editDayId" class="ef-input" value="${day.id || ""}">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">日期文字 (例如: 10月5日（日）)</div>
      <input type="text" id="editDayDate" class="ef-input" value="${day.date || ""}">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">當日主題名稱 <span style="color:var(--red);">*</span></div>
      <input type="text" id="editDayTitle" class="ef-input" value="${day.title || ""}">
    </div>
  `;

  openFormModal({
    title: `✏️ 編輯 ${day.id} 主題與日期`,
    bodyHtml: formHtml,
    confirmText: "儲存並同步",
    onConfirm: () => {
      const id = document.getElementById("editDayId").value.trim() || day.id;
      const title = document.getElementById("editDayTitle").value.trim();
      const date = document.getElementById("editDayDate").value.trim();

      if (!title) {
        alert("主題名稱不得為空！");
        return false;
      }

      tripData.days[dayIdx].id = id;
      tripData.days[dayIdx].title = title;
      tripData.days[dayIdx].date = date;

      renderItinerary();
      save();
      return true;
    },
  });
}

function openEditItineraryModal(dayIdx, itemIdx) {
  const item = tripData.days[dayIdx].items[itemIdx];
  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">時間 (點選快捷標籤或直接輸入)</div>
      <div class="time-tags">
        <button type="button" class="time-tag" onclick="document.getElementById('editItTime').value='早上'">🌅 早上</button>
        <button type="button" class="time-tag" onclick="document.getElementById('editItTime').value='上午'">☀️ 上午</button>
        <button type="button" class="time-tag" onclick="document.getElementById('editItTime').value='中午'">🍱 中午</button>
        <button type="button" class="time-tag" onclick="document.getElementById('editItTime').value='下午'">☕ 下午</button>
        <button type="button" class="time-tag" onclick="document.getElementById('editItTime').value='傍晚'">🌆 傍晚</button>
        <button type="button" class="time-tag" onclick="document.getElementById('editItTime').value='晚上'">🌙 晚上</button>
        <button type="button" class="time-tag" onclick="document.getElementById('editItTime').value='全天'">🚩 全天</button>
        <button type="button" class="time-tag" onclick="document.getElementById('editItTime').value='09:00'">09:00</button>
        <button type="button" class="time-tag" onclick="document.getElementById('editItTime').value='12:00'">12:00</button>
        <button type="button" class="time-tag" onclick="document.getElementById('editItTime').value='14:00'">14:00</button>
        <button type="button" class="time-tag" onclick="document.getElementById('editItTime').value='18:00'">18:00</button>
      </div>
      <input type="text" id="editItTime" class="ef-input" placeholder="例如: 上午、10:30、14:00~16:00" value="${item.time || ""}">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">景點或活動名稱 <span style="color:var(--red);">*</span></div>
      <input type="text" id="editItPlace" class="ef-input" value="${item.place || ""}">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">說明備忘事項</div>
      <textarea id="editItDesc" class="ef-textarea" placeholder="例如: 門票預約、參拜動線、推薦拍照點">${item.desc || ""}</textarea>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">上傳/更換景點照片 (5MB內，選填)</div>
      <input type="file" accept="image/*" id="editItFile" onchange="uploadImageInModal(this, 'editItImgUrl', 'modalImgPreview')">
      <input type="hidden" id="editItImgUrl" value="${item.imgUrl || ""}">
    </div>
    <div id="modalImgPreview" style="margin-top:6px;">
      ${item.imgUrl
      ? `<img src="${formatDriveImageUrl(item.imgUrl)}" referrerpolicy="no-referrer" style="max-height:140px;border-radius:8px;display:block;object-fit:cover;" onerror="handleImgError(this)">
             <button type="button" class="btn-mini btn-mini-danger" style="margin-top:6px;" onclick="removeModalImage('editItImgUrl', 'modalImgPreview')">🗑️ 移除此照片</button>`
      : ""
    }
    </div>
  `;

  openFormModal({
    title: "✏️ 編輯行程景點",
    bodyHtml: formHtml,
    confirmText: "儲存修改並同步",
    onConfirm: () => {
      const place = document.getElementById("editItPlace").value.trim();
      if (!place) {
        alert("景點名稱不得為空！");
        return false;
      }

      tripData.days[dayIdx].items[itemIdx].time = document
        .getElementById("editItTime")
        .value.trim();
      tripData.days[dayIdx].items[itemIdx].place = place;
      tripData.days[dayIdx].items[itemIdx].desc = document
        .getElementById("editItDesc")
        .value.trim();
      tripData.days[dayIdx].items[itemIdx].imgUrl = formatDriveImageUrl(
        document.getElementById("editItImgUrl").value.trim()
      );

      renderItinerary();
      save();
      return true;
    },
  });
}

function removeModalImage(imgUrlInputId, previewDivId) {
  document.getElementById(imgUrlInputId).value = "";
  document.getElementById(previewDivId).innerHTML =
    "<span style='font-size:12px;color:#888;'>已標記移除照片，點擊確認後生效</span>";
}

async function uploadImageInModal(input, imgUrlInputId, previewDivId) {
  const file = input.files[0];
  if (!file) return;

  if (file.size > 5 * 1024 * 1024) {
    alert("圖片檔案過大（超過 5MB），請壓縮後再上傳！");
    input.value = "";
    return;
  }

  showToast("圖片上傳中，請稍候...");
  const previewDiv = document.getElementById(previewDivId);
  previewDiv.innerHTML =
    "<span style='font-size:12px;color:var(--moss);'>⏳ 照片上傳中...</span>";

  const reader = new FileReader();
  reader.onload = async function (e) {
    const base64Data = e.target.result.split(",")[1];
    try {
      const res = await fetch(GAS_API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "uploadImage",
          token: idToken,
          tripUuid: currentTripUuid,
          filename: file.name,
          mimeType: file.type,
          data: base64Data,
        }),
      });
      const result = await res.json();
      if (result.status === "success") {
        const formattedUrl = formatDriveImageUrl(result.url);
        document.getElementById(imgUrlInputId).value = formattedUrl;
        previewDiv.innerHTML = `
          <img src="${formattedUrl}" referrerpolicy="no-referrer" style="max-height:140px;border-radius:8px;display:block;object-fit:cover;" onerror="handleImgError(this)">
          <button type="button" class="btn-mini btn-mini-danger" style="margin-top:6px;" onclick="removeModalImage('${imgUrlInputId}', '${previewDivId}')">🗑️ 移除此照片</button>
        `;
        showToast("照片上傳成功 ✓");
      } else {
        alert("上傳失敗：" + (result.message || "未知錯誤"));
        previewDiv.innerHTML = "";
      }
    } catch (e) {
      alert("上傳異常，請檢查網路連線");
      previewDiv.innerHTML = "";
    }
  };
  reader.readAsDataURL(file);
}

function deleteItineraryItem(dayIdx, itemIdx) {
  const item = tripData.days[dayIdx].items[itemIdx];
  openConfirmModal({
    title: "刪除景點確認",
    message: `確定要刪除景點「${item.place || "此行程"}」嗎？`,
    danger: true,
    confirmText: "確定刪除",
    onConfirm: () => {
      tripData.days[dayIdx].items.splice(itemIdx, 1);
      renderItinerary();
      save();
    },
  });
}

function openAddItineraryModal(dayIdx) {
  const currentDay = tripData.days[dayIdx];
  const dayTitle = currentDay ? currentDay.id : `Day ${dayIdx + 1}`;

  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">時間 (點選快捷標籤或直接輸入)</div>
      <div class="time-tags">
        <button type="button" class="time-tag" onclick="document.getElementById('addItineraryTime').value='早上'">🌅 早上</button>
        <button type="button" class="time-tag" onclick="document.getElementById('addItineraryTime').value='上午'">☀️ 上午</button>
        <button type="button" class="time-tag" onclick="document.getElementById('addItineraryTime').value='中午'">🍱 中午</button>
        <button type="button" class="time-tag" onclick="document.getElementById('addItineraryTime').value='下午'">☕ 下午</button>
        <button type="button" class="time-tag" onclick="document.getElementById('addItineraryTime').value='傍晚'">🌆 傍晚</button>
        <button type="button" class="time-tag" onclick="document.getElementById('addItineraryTime').value='晚上'">🌙 晚上</button>
        <button type="button" class="time-tag" onclick="document.getElementById('addItineraryTime').value='全天'">🚩 全天</button>
        <button type="button" class="time-tag" onclick="document.getElementById('addItineraryTime').value='09:00'">09:00</button>
        <button type="button" class="time-tag" onclick="document.getElementById('addItineraryTime').value='12:00'">12:00</button>
        <button type="button" class="time-tag" onclick="document.getElementById('addItineraryTime').value='14:00'">14:00</button>
        <button type="button" class="time-tag" onclick="document.getElementById('addItineraryTime').value='18:00'">18:00</button>
      </div>
      <input type="text" id="addItineraryTime" class="ef-input" placeholder="例如: 上午、10:30、14:00~16:00" value="上午">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">景點或活動名稱 <span style="color:var(--red);">*</span></div>
      <input type="text" id="addItineraryPlace" class="ef-input" placeholder="例如: 淺草寺 雷門">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">說明備忘事項</div>
      <textarea id="addItineraryDesc" class="ef-textarea" placeholder="例如: 參拜、拍照、購買御守"></textarea>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">上傳景點照片 (5MB內，選填)</div>
      <input type="file" accept="image/*" id="addItFile" onchange="uploadImageInModal(this, 'addItImgUrl', 'addModalImgPreview')">
      <input type="hidden" id="addItImgUrl" value="">
    </div>
    <div id="addModalImgPreview" style="margin-top:6px;"></div>
  `;

  openFormModal({
    title: `➕ 新增 ${dayTitle} 行程景點`,
    bodyHtml: formHtml,
    confirmText: "確認新增並同步",
    onConfirm: () => {
      const time = document.getElementById("addItineraryTime").value.trim();
      const place = document.getElementById("addItineraryPlace").value.trim();
      const desc = document.getElementById("addItineraryDesc").value.trim();
      const imgUrl = formatDriveImageUrl(document.getElementById("addItImgUrl").value.trim());

      if (!place) {
        alert("請輸入景點名稱！");
        return false;
      }

      if (!tripData.days[dayIdx].items) tripData.days[dayIdx].items = [];
      tripData.days[dayIdx].items.push({
        id: uid(),
        time: time || "上午",
        place: place,
        desc: desc,
        imgUrl: imgUrl || "",
      });

      renderItinerary();
      save();
      return true;
    },
  });
}

// =========================================================================
// 4. 美食清單 (Food) - 美食單筆微編輯、地圖導航、照片上傳與即時同步
// =========================================================================
function renderFood() {
  if (!tripData) return;
  const list = tripData.food || [];
  const isAdmin = userRole === "admin";

  const items = list
    .map((item, i) => {
      const adminActions = isAdmin
        ? `<div class="item-actions">
             <button class="btn-mini" onclick="openEditFoodModal(${i})">✏️ 修改</button>
             <button class="btn-mini btn-mini-danger" onclick="deleteFoodItem(${i})">🗑️ 刪除</button>
           </div>`
        : "";

      const safeEmoji = escapeHtml(item.emoji || "🍴");
      const safeName = escapeHtml(item.name || "");
      const safeDesc = escapeHtml(item.desc || "");
      const safeImgUrl = sanitizeUrl(item.imgUrl);

      // 自動依美食/店家名稱產生 Google 地圖導航搜尋連結
      const autoMapUrl = item.name
        ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(item.name)
        : "";

      const hasImg = safeImgUrl && safeImgUrl !== "#";

      return `
        <div style="padding:16px 0;border-bottom:1px solid var(--mist);">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <!-- 美食圖示或上傳的美食照片 -->
            ${hasImg
          ? `<img src="${safeImgUrl}" referrerpolicy="no-referrer" loading="lazy" class="shopping-thumb" onerror="handleImgError(this)">`
          : `<span style="font-size:32px;flex-shrink:0;opacity:${item.done ? 0.35 : 1};line-height:1;">${safeEmoji}</span>`
        }

            <div style="flex:1;min-width:0;${item.done ? "text-decoration:line-through;opacity:0.45;" : ""}">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
                <div style="font-size:16px;font-weight:800;color:var(--ink);">
                  ${safeName}
                  ${item.must
          ? '<span style="font-size:10px;background:var(--red);color:#fff;padding:2px 6px;border-radius:4px;vertical-align:middle;font-weight:normal;margin-left:4px;">必吃</span>'
          : ""
        }
                </div>
                ${adminActions}
              </div>

              <!-- 地圖導航按鈕 -->
              <div style="margin-top:6px;">
                ${autoMapUrl ? `<a class="map-link" style="margin-top:0;" href="${autoMapUrl}" target="_blank" rel="noopener noreferrer">🗺 地圖導航</a>` : ""}
              </div>

              ${safeDesc
          ? `<div style="font-size:12px;color:#666;margin-top:6px;background:#FAF8F5;padding:6px 10px;border-radius:8px;border:1px dashed var(--mist);line-height:1.5;">${safeDesc}</div>`
          : ""
        }
            </div>

            <button onclick="toggleFoodDone(${i})" style="flex-shrink:0;border:none;border-radius:14px;padding:6px 14px;font-size:11px;font-weight:bold;cursor:pointer;background:${item.done ? "var(--moss)" : "var(--mist)"
        };color:${item.done ? "#fff" : "#666"};transition:all 0.2s;margin-top:2px;">
              ${item.done ? "已品嚐 ✓" : "想吃"}
            </button>
          </div>
        </div>
      `;
    })
    .join("");

  const addBtn = isAdmin
    ? `<button class="glass-btn" style="background:var(--moss);color:#fff;width:100%;margin-top:16px;justify-content:center;" onclick="openAddFoodModal()">＋ 新增美食</button>`
    : "";

  document.getElementById("page-food").innerHTML = `
    <div class="card">
      <div class="card-header">
        <span class="card-title">🍽 旅遊口袋名單</span>
      </div>
      ${items || '<p style="color:#888;">尚未加入美食</p>'}
      ${addBtn}
    </div>
  `;
}

function toggleFoodDone(index) {
  tripData.food[index].done = !tripData.food[index].done;
  save();
  renderFood();
}

function openEditFoodModal(index) {
  const item = tripData.food[index];
  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">美食圖示 (Emoji)</div>
      <input type="text" id="editFoodEmoji" class="ef-input" value="${item.emoji || "🍴"}" style="width:60px;text-align:center;">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">美食或店家名稱 <span style="color:var(--red);">*</span> (輸入後自動產生地圖導航)</div>
      <input type="text" id="editFoodName" class="ef-input" value="${item.name || ""}">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">特色說明或推薦菜色</div>
      <input type="text" id="editFoodDesc" class="ef-input" value="${item.desc || ""}">
    </div>
    <label style="font-size:13px;color:var(--moss);font-weight:bold;display:flex;align-items:center;gap:6px;margin-top:10px;cursor:pointer;">
      <input type="checkbox" id="editFoodMust" ${item.must ? "checked" : ""}> 標記為必吃名店 🔥
    </label>
    <div class="ef-wrap" style="margin-top:12px;">
      <div class="ef-label">上傳/更換美食照片 (5MB內，選填)</div>
      <input type="file" accept="image/*" id="editFoodFile" onchange="uploadImageInModal(this, 'editFoodImgUrl', 'editFoodModalImgPreview')">
      <input type="hidden" id="editFoodImgUrl" value="${item.imgUrl || ""}">
    </div>
    <div id="editFoodModalImgPreview" style="margin-top:6px;">
      ${item.imgUrl
        ? `<img src="${formatDriveImageUrl(item.imgUrl)}" referrerpolicy="no-referrer" style="max-height:140px;border-radius:8px;display:block;object-fit:cover;" onerror="handleImgError(this)">
           <button type="button" class="btn-mini btn-mini-danger" style="margin-top:6px;" onclick="removeModalImage('editFoodImgUrl', 'editFoodModalImgPreview')">🗑️ 移除此照片</button>`
        : ""
      }
    </div>
  `;

  openFormModal({
    title: "✏️ 編輯美食口袋名單",
    bodyHtml: formHtml,
    confirmText: "儲存修改並同步",
    onConfirm: () => {
      const name = document.getElementById("editFoodName").value.trim();
      if (!name) {
        alert("美食名稱不得為空！");
        return false;
      }

      tripData.food[index].emoji =
        document.getElementById("editFoodEmoji").value.trim() || "🍴";
      tripData.food[index].name = name;
      tripData.food[index].area = "";
      tripData.food[index].desc = document
        .getElementById("editFoodDesc")
        .value.trim();
      tripData.food[index].must =
        document.getElementById("editFoodMust").checked;
      tripData.food[index].imgUrl = formatDriveImageUrl(
        document.getElementById("editFoodImgUrl").value.trim()
      );

      renderFood();
      save();
      return true;
    },
  });
}

function deleteFoodItem(index) {
  const item = tripData.food[index];
  openConfirmModal({
    title: "刪除美食確認",
    message: `確定要刪除美食「${item.name || "此項目"}」嗎？`,
    danger: true,
    confirmText: "確定刪除",
    onConfirm: () => {
      tripData.food.splice(index, 1);
      renderFood();
      save();
    },
  });
}

function openAddFoodModal() {
  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">美食圖示 (Emoji)</div>
      <input type="text" id="addFoodEmoji" class="ef-input" value="🍴" style="width:60px;text-align:center;">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">美食或店家名稱 <span style="color:var(--red);">*</span> (輸入後自動產生地圖導航)</div>
      <input type="text" id="addFoodName" class="ef-input" placeholder="例如: 一蘭拉麵 岡山站前店、日生町牡蠣燒">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">特色說明或推薦菜色</div>
      <input type="text" id="addFoodDesc" class="ef-input" placeholder="例如: 招牌豚骨拉麵、岡山限定冬季美味">
    </div>
    <label style="font-size:13px;color:var(--moss);font-weight:bold;display:flex;align-items:center;gap:6px;margin-top:10px;cursor:pointer;">
      <input type="checkbox" id="addFoodMust"> 標記為必吃名店 🔥
    </label>
    <div class="ef-wrap" style="margin-top:12px;">
      <div class="ef-label">上傳美食照片 (5MB內，選填)</div>
      <input type="file" accept="image/*" id="addFoodFile" onchange="uploadImageInModal(this, 'addFoodImgUrl', 'addFoodModalImgPreview')">
      <input type="hidden" id="addFoodImgUrl" value="">
    </div>
    <div id="addFoodModalImgPreview" style="margin-top:6px;"></div>
  `;

  openFormModal({
    title: "➕ 新增美食口袋名單",
    bodyHtml: formHtml,
    confirmText: "確認新增並同步",
    onConfirm: () => {
      const emoji =
        document.getElementById("addFoodEmoji").value.trim() || "🍴";
      const name = document.getElementById("addFoodName").value.trim();
      const desc = document.getElementById("addFoodDesc").value.trim();
      const must = document.getElementById("addFoodMust").checked;
      const imgUrl = formatDriveImageUrl(
        document.getElementById("addFoodImgUrl").value.trim()
      );

      if (!name) {
        alert("請輸入美食或店家名稱！");
        return false;
      }

      if (!tripData.food) tripData.food = [];
      tripData.food.push({
        id: uid(),
        emoji: emoji,
        name: name,
        area: "",
        desc: desc,
        must: must,
        done: false,
        imgUrl: imgUrl || "",
      });

      renderFood();
      save();
      return true;
    },
  });
}

// =========================================================================
// 5. 代購商品 (Shopping) - 代購者、商品、地點(Google Maps)、價格、網址、照片與採買狀態
// =========================================================================
// 預設代購委託人常用名單（亦會自動智能合併歷史已新增過的代購者）
const DEFAULT_BUYERS = ["自己", "鴨", "媽媽", "包果", "小豬", "哲源", "朋友", "同事"];

function getBuyerTagsHtml(inputElId) {
  const customBuyers = (tripData?.shopping || [])
    .map((s) => (s.buyer || "").trim())
    .filter((b) => b && !DEFAULT_BUYERS.includes(b));
  const allBuyers = [...DEFAULT_BUYERS, ...Array.from(new Set(customBuyers))];

  return allBuyers
    .map(
      (b) =>
        `<button type="button" class="time-tag" onclick="document.getElementById('${inputElId}').value='${escapeHtml(
          b
        )}'">${escapeHtml(b)}</button>`
    )
    .join("");
}

// =========================================================================
// 5. 代購商品 (Shopping) - 代購者、數量、商品、地點(Google Maps)、價格、網址、照片與採買狀態
// =========================================================================
function renderShopping() {
  if (!tripData) return;
  const list = tripData.shopping || [];
  const isAdmin = userRole === "admin";

  const totalCount = list.length;
  const doneCount = list.filter((it) => it.done).length;

  const items = list
    .map((item, i) => {
      // 只要有填寫地點或店名，或以商品名稱為備用，自動生成 Google 地圖導航搜尋網址
      const queryTarget = (item.location || "").trim() || (item.name || "").trim();
      const autoMapUrl = queryTarget
        ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(queryTarget)
        : "";

      const safeLink = sanitizeUrl(item.link);
      const safeImgUrl = sanitizeUrl(item.imgUrl);
      const safeBuyer = escapeHtml(item.buyer || "委託人");
      const safeName = escapeHtml(item.name || "未命名商品");
      const safeLocation = escapeHtml(item.location || "");
      const safePrice = escapeHtml(item.price || "");
      const safeQty = escapeHtml(item.qty || "1");
      const safeNote = escapeHtml(item.note || "");

      const adminActions = isAdmin
        ? `<div class="item-actions">
             <button class="btn-mini" onclick="openEditShoppingModal(${i})">✏️ 修改</button>
             <button class="btn-mini btn-mini-danger" onclick="deleteShoppingItem(${i})">🗑️ 刪除</button>
           </div>`
        : "";

      const hasImg = safeImgUrl && safeImgUrl !== "#";

      return `
        <div class="shopping-card ${item.done ? "done" : ""}">
          <!-- 卡片頂部資訊膠囊列 -->
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:6px;">
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;">
              <span class="buyer-badge">👤 ${safeBuyer}</span>
              <span class="qty-badge">🔢 數量: ${safeQty}</span>
              ${safePrice ? `<span class="price-badge">💰 ${safePrice}</span>` : ""}
            </div>
            ${adminActions}
          </div>

          <!-- 卡片主體內容（支援左圖右文結構） -->
          <div style="display:flex;align-items:flex-start;gap:12px;">
            <input type="checkbox" style="width:20px;height:20px;accent-color:var(--moss);margin-top:2px;cursor:pointer;flex-shrink:0;" ${item.done ? "checked" : ""
        } onclick="toggleShoppingDone(${i})">
            
            <div style="flex:1;min-width:0;${item.done ? "text-decoration:line-through;opacity:0.45;" : ""}">
              <div style="display:flex;gap:14px;align-items:flex-start;">
                ${hasImg
          ? `<img src="${safeImgUrl}" referrerpolicy="no-referrer" loading="lazy" class="shopping-thumb" onerror="handleImgError(this)">`
          : ""
        }
                <div style="flex:1;min-width:0;">
                  <div style="font-size:16px;font-weight:900;color:var(--ink);line-height:1.35;">${safeName}</div>
                  
                  ${safeLocation
          ? `<div style="font-size:12px;color:var(--moss);font-weight:800;margin-top:6px;display:flex;align-items:center;flex-wrap:wrap;gap:6px;">
                         <span>📍 ${safeLocation}</span>
                         ${autoMapUrl ? `<a class="map-link" style="margin-top:0;" href="${autoMapUrl}" target="_blank" rel="noopener noreferrer">🗺 地圖導航</a>` : ""}
                       </div>`
          : (autoMapUrl
            ? `<div style="margin-top:6px;">
                         <a class="map-link" style="margin-top:0;" href="${autoMapUrl}" target="_blank" rel="noopener noreferrer">🗺 地圖導航</a>
                       </div>`
            : "")
        }
                  
                  ${safeNote
          ? `<div style="font-size:12px;color:#555;margin-top:6px;background:#FAF8F5;padding:6px 10px;border-radius:8px;border:1px dashed var(--mist);line-height:1.5;">
                         📝 ${safeNote}
                       </div>`
          : ""
        }

                  ${safeLink && safeLink !== "#"
          ? `<div style="margin-top:8px;">
                         <a class="ext-link" style="margin-top:0;" href="${safeLink}" target="_blank" rel="noopener noreferrer">🔗 商品介紹/網址</a>
                       </div>`
          : ""
        }
                </div>
              </div>
            </div>
            
            <button onclick="toggleShoppingDone(${i})" style="flex-shrink:0;border:none;border-radius:14px;padding:6px 12px;font-size:11px;font-weight:bold;cursor:pointer;background:${item.done ? "var(--moss)" : "var(--mist)"
        };color:${item.done ? "#fff" : "#666"};transition:all 0.2s;">
              ${item.done ? "已購買 ✓" : "想買"}
            </button>
          </div>
        </div>
      `;
    })
    .join("");

  const addBtn = isAdmin
    ? `<button class="glass-btn" style="background:var(--moss);color:#fff;width:100%;margin-top:16px;justify-content:center;" onclick="openAddShoppingModal()">＋ 新增代購商品</button>`
    : "";

  document.getElementById("page-shopping").innerHTML = `
    <div class="card">
      <div class="card-header">
        <div>
          <span class="card-title">🛍️ 伴手禮與代購清單</span>
          <div style="font-size:11px;color:var(--gold);font-weight:700;margin-top:2px;">
            共 ${totalCount} 件商品 ｜ 已採買 ${doneCount} 件
          </div>
        </div>
      </div>
      ${items || '<p style="color:#888;font-size:13px;padding:10px 0;">目前尚未新增任何代購商品，請點擊下方按鈕新增！</p>'}
      ${addBtn}
    </div>
  `;
}

function toggleShoppingDone(index) {
  if (!tripData.shopping || !tripData.shopping[index]) return;
  tripData.shopping[index].done = !tripData.shopping[index].done;
  save();
  renderShopping();
}

function openAddShoppingModal() {
  const buyerTags = getBuyerTagsHtml("addShoppingBuyer");
  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">代購者 / 委託人 (點選常用標籤或直接輸入)</div>
      <div class="time-tags">
        ${buyerTags}
      </div>
      <input type="text" id="addShoppingBuyer" class="ef-input" placeholder="例如: 自己、媽媽、小明" value="自己">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">商品名稱 <span style="color:var(--red);">*</span></div>
      <input type="text" id="addShoppingName" class="ef-input" placeholder="例如: 合利他命 EX Plus 270錠、獺祭二割三分">
    </div>
    <div style="display:flex;gap:10px;">
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">數量 (例如: 1、2盒、3瓶)</div>
        <input type="text" id="addShoppingQty" class="ef-input" placeholder="例如: 1 或 2瓶" value="1">
      </div>
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">預估價格 / 預算 (選填)</div>
        <input type="text" id="addShoppingPrice" class="ef-input" placeholder="例如: ¥5,800 或 NT$ 1,200">
      </div>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">購買地點 / 店名 (輸入後自動產生 Google 地圖導航按鈕)</div>
      <input type="text" id="addShoppingLocation" class="ef-input" placeholder="例如: BicCamera 岡山站前店、驚安殿堂唐吉訶德、大國藥妝">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">參考網址 (商品介紹或線上商城連結，選填)</div>
      <input type="text" id="addShoppingLink" class="ef-input" placeholder="https://...">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">備註說明 (規格、色號、退稅注意事項等)</div>
      <textarea id="addShoppingNote" class="ef-textarea" placeholder="例如: 買2盒、需退稅、請認明藍色包裝"></textarea>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">上傳商品照片 (5MB內，選填)</div>
      <input type="file" accept="image/*" id="addShoppingFile" onchange="uploadImageInModal(this, 'addShoppingImgUrl', 'addShoppingModalImgPreview')">
      <input type="hidden" id="addShoppingImgUrl" value="">
    </div>
    <div id="addShoppingModalImgPreview" style="margin-top:6px;"></div>
  `;

  openFormModal({
    title: "➕ 新增代購商品",
    bodyHtml: formHtml,
    confirmText: "確認新增並同步",
    onConfirm: () => {
      const buyer = document.getElementById("addShoppingBuyer").value.trim() || "自己";
      const name = document.getElementById("addShoppingName").value.trim();
      const qty = document.getElementById("addShoppingQty").value.trim() || "1";
      const location = document.getElementById("addShoppingLocation").value.trim();
      const price = document.getElementById("addShoppingPrice").value.trim();
      const link = document.getElementById("addShoppingLink").value.trim();
      const note = document.getElementById("addShoppingNote").value.trim();
      const imgUrl = formatDriveImageUrl(document.getElementById("addShoppingImgUrl").value.trim());

      if (!name) {
        alert("請輸入商品名稱！");
        return false;
      }

      if (!tripData.shopping) tripData.shopping = [];
      tripData.shopping.push({
        id: uid(),
        buyer: buyer,
        name: name,
        qty: qty,
        location: location,
        price: price,
        link: link,
        imgUrl: imgUrl || "",
        note: note,
        done: false,
      });

      renderShopping();
      save();
      return true;
    },
  });
}

function openEditShoppingModal(index) {
  const item = tripData.shopping[index];
  const buyerTags = getBuyerTagsHtml("editShoppingBuyer");
  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">代購者 / 委託人 (點選常用標籤或直接輸入)</div>
      <div class="time-tags">
        ${buyerTags}
      </div>
      <input type="text" id="editShoppingBuyer" class="ef-input" value="${item.buyer || "自己"}">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">商品名稱 <span style="color:var(--red);">*</span></div>
      <input type="text" id="editShoppingName" class="ef-input" value="${item.name || ""}">
    </div>
    <div style="display:flex;gap:10px;">
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">數量 (例如: 1、2盒、3瓶)</div>
        <input type="text" id="editShoppingQty" class="ef-input" value="${item.qty || "1"}">
      </div>
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">預估價格 / 預算</div>
        <input type="text" id="editShoppingPrice" class="ef-input" value="${item.price || ""}">
      </div>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">購買地點 / 店名 (輸入後自動產生 Google 地圖導航按鈕)</div>
      <input type="text" id="editShoppingLocation" class="ef-input" placeholder="例如: BicCamera 岡山站前店、驚安殿堂唐吉訶德、大國藥妝" value="${item.location || ""}">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">參考網址</div>
      <input type="text" id="editShoppingLink" class="ef-input" value="${item.link || ""}">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">備註說明 (規格、色號、退稅注意事項等)</div>
      <textarea id="editShoppingNote" class="ef-textarea">${item.note || ""}</textarea>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">上傳/更換商品照片 (5MB內，選填)</div>
      <input type="file" accept="image/*" id="editShoppingFile" onchange="uploadImageInModal(this, 'editShoppingImgUrl', 'editShoppingModalImgPreview')">
      <input type="hidden" id="editShoppingImgUrl" value="${item.imgUrl || ""}">
    </div>
    <div id="editShoppingModalImgPreview" style="margin-top:6px;">
      ${item.imgUrl
        ? `<img src="${formatDriveImageUrl(item.imgUrl)}" referrerpolicy="no-referrer" style="max-height:140px;border-radius:8px;display:block;object-fit:cover;" onerror="handleImgError(this)">
           <button type="button" class="btn-mini btn-mini-danger" style="margin-top:6px;" onclick="removeModalImage('editShoppingImgUrl', 'editShoppingModalImgPreview')">🗑️ 移除此照片</button>`
        : ""
      }
    </div>
  `;

  openFormModal({
    title: "✏️ 編輯代購商品",
    bodyHtml: formHtml,
    confirmText: "儲存修改並同步",
    onConfirm: () => {
      const name = document.getElementById("editShoppingName").value.trim();
      if (!name) {
        alert("商品名稱不得為空！");
        return false;
      }

      tripData.shopping[index].buyer = document.getElementById("editShoppingBuyer").value.trim() || "自己";
      tripData.shopping[index].name = name;
      tripData.shopping[index].qty = document.getElementById("editShoppingQty").value.trim() || "1";
      tripData.shopping[index].location = document.getElementById("editShoppingLocation").value.trim();
      tripData.shopping[index].price = document.getElementById("editShoppingPrice").value.trim();
      tripData.shopping[index].link = document.getElementById("editShoppingLink").value.trim();
      tripData.shopping[index].note = document.getElementById("editShoppingNote").value.trim();
      tripData.shopping[index].imgUrl = formatDriveImageUrl(document.getElementById("editShoppingImgUrl").value.trim());

      renderShopping();
      save();
      return true;
    },
  });
}

function deleteShoppingItem(index) {
  const item = tripData.shopping[index];
  openConfirmModal({
    title: "刪除代購商品確認",
    message: `確定要刪除代購商品「${item.name || "此項目"}」嗎？`,
    danger: true,
    confirmText: "確定刪除",
    onConfirm: () => {
      tripData.shopping.splice(index, 1);
      renderShopping();
      save();
    },
  });
}

// =========================================================================
// 6. 後台管理頁面 (Admin) - 行程建立、日期維護與授權清單管理
// =========================================================================
function renderAdmin() {
  if (userRole !== "admin") return;

  const html = `
    <div class="card">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;">
        <span class="card-title" style="color:var(--red);">⚙️ 系統管理員後台</span>
        <button class="card-header-btn" onclick="openCreateTripModal()" style="background:var(--moss);color:#fff;">➕ 建立新行程</button>
      </div>
      
      <div style="margin-top:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="font-size:14px;font-weight:bold;color:var(--moss);margin:0;">📋 已綁定行程管理</h3>
          <span style="font-size:11px;color:#888;">共 ${tripsList.length} 個行程</span>
        </div>
        <div id="adminTripsList">載入行程列表中...</div>
      </div>
    </div>
  `;

  document.getElementById("page-admin").innerHTML = html;
  renderAdminTripsList();
}

function renderAdminTripsList() {
  const container = document.getElementById("adminTripsList");
  if (!container) return;
  if (tripsList.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:30px 10px;background:#FAF8F5;border-radius:14px;border:1px dashed var(--gold);">
        <p style="color:#888;font-size:13px;margin-bottom:12px;">目前尚未建立任何旅遊行程</p>
        <button class="glass-btn" style="background:var(--moss);color:#fff;display:inline-flex;" onclick="openCreateTripModal()">＋ 立即建立第一筆行程</button>
      </div>
    `;
    return;
  }

  const listHtml = tripsList
    .map(
      (t) => `
    <div style="background:#FFF;border-radius:12px;padding:14px;margin-bottom:12px;border:1px solid var(--mist);font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,0.03);">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <span style="font-weight:900;font-size:15px;color:var(--moss);">${escapeHtml(t.name)}</span>
          <span style="font-size:11px;color:#888;margin-left:6px;background:#F0EFEA;padding:2px 6px;border-radius:6px;">${escapeHtml(t.uuid)}</span>
        </div>
        <button class="btn-mini" onclick="openEditTripMetaModal('${escapeHtml(t.uuid)}')">✏️ 編輯設定</button>
      </div>
      <div style="color:#666;margin-top:8px;line-height:1.6;">
        <div>📄 試算表 ID: <span style="font-family:monospace;font-size:11px;background:#F9F9F9;padding:1px 4px;border-radius:4px;">${escapeHtml(t.sheet_id || "")}</span></div>
        <div>📁 圖片資料夾 ID: <span style="font-family:monospace;font-size:11px;background:#F9F9F9;padding:1px 4px;border-radius:4px;">${escapeHtml(t.folder_id || "")}</span></div>
        <div>👥 授權團員: <span style="color:${t.allowed_users ? "#333" : "#999"};">${escapeHtml(t.allowed_users || "僅管理員")}</span></div>
      </div>
    </div>
  `,
    )
    .join("");

  container.innerHTML = listHtml;
}

// 彈出建立新行程表單對話框
function openCreateTripModal() {
  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">行程識別碼 (UUID，僅限英數與連字號) <span style="color:var(--red);">*</span></div>
      <input type="text" id="newTripUuid" class="ef-input" placeholder="例如: trip-tokyo-2028">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">行程名稱 <span style="color:var(--red);">*</span></div>
      <input type="text" id="newTripName" class="ef-input" placeholder="例如: 2028 東京賞櫻之旅">
    </div>
    <div style="display:flex;gap:10px;">
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">出發日期 <span style="color:var(--red);">*</span></div>
        <input type="date" id="newStartDate" class="ef-input" onchange="autoSyncTripDuration()">
      </div>
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">結束日期 <span style="color:var(--red);">*</span></div>
        <input type="date" id="newEndDate" class="ef-input" onchange="autoSyncTripDuration()">
      </div>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">天數說明 (自動計算，亦可手動修改)</div>
      <input type="text" id="newDuration" class="ef-input" placeholder="例如: 8天7夜">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">Google 試算表 ID <span style="font-weight:normal;color:#888;">(選填，留空將自動在雲端建立)</span></div>
      <input type="text" id="newSheetId" class="ef-input" placeholder="留空將自動在 my-travels/行程名稱/ 下建立">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">雲端硬碟資料夾 ID <span style="font-weight:normal;color:#888;">(選填，留空將自動在雲端建立)</span></div>
      <input type="text" id="newFolderId" class="ef-input" placeholder="留空將自動建立景點照片專屬資料夾">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">授權人員 Email (以英文逗號分隔，留空則僅管理員可見)</div>
      <textarea id="newAllowedUsers" class="ef-textarea" placeholder="user1@gmail.com, user2@gmail.com"></textarea>
    </div>
  `;

  openFormModal({
    title: "➕ 建立新旅遊行程",
    bodyHtml: formHtml,
    confirmText: "🚀 一鍵建立行程與雲端手冊",
    onConfirm: async () => {
      const uuid = document.getElementById("newTripUuid").value.trim();
      const name = document.getElementById("newTripName").value.trim();
      const startDate = document.getElementById("newStartDate").value.trim();
      const endDate = document.getElementById("newEndDate").value.trim();
      const duration = document.getElementById("newDuration").value.trim();
      const sheetId = document.getElementById("newSheetId").value.trim();
      const folderId = document.getElementById("newFolderId").value.trim();
      let allowedUsers = document
        .getElementById("newAllowedUsers")
        .value.trim();

      if (!uuid || !name || !startDate || !endDate) {
        alert("請填寫行程識別碼、行程名稱、出發日期與結束日期！");
        return false;
      }

      const uuidRegex = /^[a-zA-Z0-9_-]+$/;
      if (!uuidRegex.test(uuid)) {
        alert("行程識別碼格式不正確！僅允許使用英文字母、數字、底線及連字號。");
        return false;
      }

      allowedUsers = allowedUsers.replace(/，/g, ",");
      showLoading("正在雲端自動建立行程資料夾、初始化試算表結構...");

      try {
        const res = await fetch(GAS_API_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            action: "createTrip",
            token: idToken,
            uuid,
            name,
            startDate,
            endDate,
            duration: duration || "8天7夜",
            sheetId,
            folderId,
            allowedUsers,
          }),
        });
        const result = await res.json();
        if (result.status === "success") {
          showToast(result.message || "新行程建立成功且初始化完畢！ ✓");
          await fetchTrips();
          renderAdmin();
        } else {
          alert("建立失敗：" + (result.message || "未知錯誤"));
        }
      } catch (e) {
        alert("網路異常，建立行程失敗，請檢查網路連線");
      } finally {
        hideLoading();
      }
      return true;
    },
  });
}

function autoSyncTripDuration() {
  const s = document.getElementById("newStartDate")?.value;
  const e = document.getElementById("newEndDate")?.value;
  if (s && e) {
    const d1 = new Date(s + "T00:00:00");
    const d2 = new Date(e + "T00:00:00");
    const diffDays = Math.round((d2 - d1) / (1000 * 60 * 60 * 24)) + 1;
    if (diffDays > 0) {
      const nights = diffDays - 1;
      const durationInput = document.getElementById("newDuration");
      if (durationInput) {
        durationInput.value = `${diffDays}天${nights > 0 ? nights + "夜" : ""}`;
      }
    }
  }
}

// 編輯現有行程基本設定對話框
function openEditTripMetaModal(uuid) {
  const trip = tripsList.find((t) => t.uuid === uuid);
  if (!trip) return;

  const currentStartDate =
    tripData && currentTripUuid === uuid ? tripData.startDate : "";
  const currentEndDate =
    tripData && currentTripUuid === uuid ? tripData.endDate : "";
  const currentDuration =
    tripData && currentTripUuid === uuid ? tripData.duration : "";

  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">行程識別碼 (UUID，唯讀)</div>
      <input type="text" class="ef-input" value="${trip.uuid}" disabled style="background:#F0F0F0;">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">行程名稱 <span style="color:var(--red);">*</span></div>
      <input type="text" id="editTripName" class="ef-input" value="${trip.name || ""}">
    </div>
    <div style="display:flex;gap:10px;">
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">出發日期</div>
        <input type="date" id="editTripStartDate" class="ef-input" value="${currentStartDate}">
      </div>
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">結束日期</div>
        <input type="date" id="editTripEndDate" class="ef-input" value="${currentEndDate}">
      </div>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">天數說明 (例如: 8天7夜)</div>
      <input type="text" id="editTripDuration" class="ef-input" value="${currentDuration}">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">授權人員 Email (以英文逗號分隔)</div>
      <textarea id="editTripAllowedUsers" class="ef-textarea">${trip.allowed_users || ""}</textarea>
    </div>
  `;

  openFormModal({
    title: `✏️ 編輯【${trip.name}】基本設定`,
    bodyHtml: formHtml,
    confirmText: "儲存設定並同步雲端",
    onConfirm: async () => {
      const name = document.getElementById("editTripName").value.trim();
      const startDate = document
        .getElementById("editTripStartDate")
        .value.trim();
      const endDate = document.getElementById("editTripEndDate").value.trim();
      const duration = document.getElementById("editTripDuration").value.trim();
      let allowedUsers = document
        .getElementById("editTripAllowedUsers")
        .value.trim();

      if (!name) {
        alert("行程名稱不得為空！");
        return false;
      }

      allowedUsers = allowedUsers.replace(/，/g, ",");
      showLoading("正在更新行程基本設定...");

      try {
        const res = await fetch(GAS_API_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            action: "updateTripMeta",
            token: idToken,
            tripUuid: uuid,
            name,
            startDate,
            endDate,
            duration,
            allowedUsers,
          }),
        });
        const result = await res.json();
        if (result.status === "success") {
          showToast("行程設定更新成功 ✓");
          // 若修改的是當前行程，同步更新記憶體資料
          if (currentTripUuid === uuid && tripData) {
            tripData.name = name;
            tripData.startDate = startDate;
            tripData.endDate = endDate;
            tripData.duration = duration;
            initCountdown();
          }
          fetchTrips();
        } else {
          alert("更新失敗：" + (result.message || "未知錯誤"));
        }
      } catch (e) {
        alert("網路連線錯誤，更新失敗");
      } finally {
        hideLoading();
      }
      return true;
    },
  });
}

// =========================================================================
// 主渲染分流
// =========================================================================
function render() {
  if (currentTab === "checklist") renderChecklist();
  else if (currentTab === "flights") renderFlights();
  else if (currentTab === "itinerary") renderItinerary();
  else if (currentTab === "food") renderFood();
  else if (currentTab === "shopping") renderShopping();
  else if (currentTab === "admin") renderAdmin();
}
