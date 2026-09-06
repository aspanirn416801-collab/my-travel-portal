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
let currentFoodFilter = "all"; // 美食分類過濾：'all' | 'must' | 'todo' | 'done' | 地區名稱
let currentShoppingFilter = "all"; // 代購分類過濾：'all' | 'todo' | 'done' | 委託人姓名

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

// =========================================================================
// 旅程專屬密碼鎖機制 (管理員尊榮免密碼直通、訪客/團員密碼唯讀、自動記憶解鎖)
// =========================================================================
function isTripUnlocked(tripUuid, tripPassword) {
  if (userRole === "admin") return true; // 管理員尊榮特權：100% 免密碼直通
  const pwd = tripPassword !== undefined && tripPassword !== null ? String(tripPassword).trim() : "";
  if (!pwd) return true; // 未設密碼的公開行程：免密碼直接唯讀瀏覽
  const savedUnlock = localStorage.getItem("unlocked_trip_" + tripUuid);
  return savedUnlock === pwd;
}

function markTripUnlocked(tripUuid, tripPassword) {
  const pwd = tripPassword !== undefined && tripPassword !== null ? String(tripPassword).trim() : "";
  localStorage.setItem("unlocked_trip_" + tripUuid, pwd);
}

function togglePasswordVisibility(inputId, btnEl) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === "password") {
    input.type = "text";
    btnEl.innerText = "🙈";
  } else {
    input.type = "password";
    btnEl.innerText = "👁️";
  }
}

function openTripPasswordModal(trip, onUnlockSuccess, onCancel) {
  const safeName = escapeHtml(trip.name || trip.uuid || "此旅程");
  const formHtml = `
    <div style="text-align:center;margin-bottom:18px;">
      <div style="font-size:38px;margin-bottom:8px;">🔒</div>
      <div style="font-size:16px;font-weight:900;color:var(--ink);">【${safeName}】設有專屬密碼保護</div>
      <div style="font-size:12px;color:#777;margin-top:6px;line-height:1.5;">請輸入專屬密碼以唯讀檢視手冊內容<br>（解鎖成功後自動記憶於本機，無需重複輸入）</div>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">請輸入存取密碼 <span style="color:var(--red);">*</span></div>
      <div style="position:relative;">
        <input type="password" id="tripUnlockPwdInput" class="ef-input" placeholder="請輸入密碼" autofocus style="padding-right:42px;" onkeydown="if(event.key==='Enter'){document.getElementById('modalConfirmBtn').click();}">
        <button type="button" onclick="togglePasswordVisibility('tripUnlockPwdInput', this)" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:16px;padding:4px;color:#777;" title="切換顯示密碼">👁️</button>
      </div>
      <div id="tripUnlockError" style="color:var(--red);font-size:12px;margin-top:6px;font-weight:700;display:none;">❌ 密碼錯誤，請重新輸入！</div>
    </div>
  `;

  openFormModal({
    title: "🔐 私密旅程解鎖",
    bodyHtml: formHtml,
    confirmText: "🔓 解鎖手冊",
    onConfirm: () => {
      const inputVal = (document.getElementById("tripUnlockPwdInput").value || "").trim();
      const expectedPwd = String(trip.password || "").trim();
      if (!inputVal) {
        alert("請輸入存取密碼！");
        return false;
      }
      if (inputVal !== expectedPwd) {
        const errEl = document.getElementById("tripUnlockError");
        if (errEl) errEl.style.display = "block";
        const inputEl = document.getElementById("tripUnlockPwdInput");
        if (inputEl) {
          inputEl.style.borderColor = "var(--red)";
          inputEl.select();
        }
        return false;
      }
      // 驗證通過
      markTripUnlocked(trip.uuid, expectedPwd);
      showToast("密碼驗證成功，手冊已解鎖 ✓");
      if (typeof onUnlockSuccess === "function") {
        onUnlockSuccess();
      }
      return true;
    },
    onCancel: () => {
      if (typeof onCancel === "function") {
        onCancel();
      }
    }
  });
}

// 點擊大廳行程卡片時的安全進入路由
function openTripByUuid(uuid) {
  const trip = tripsList.find((t) => t.uuid === uuid);
  const tripPassword = trip ? (trip.password || "") : (tripData && tripData.uuid === uuid ? (tripData.password || "") : "");

  if (isTripUnlocked(uuid, tripPassword)) {
    navigateTo(uuid);
  } else {
    openTripPasswordModal(trip || { uuid, name: uuid, password: tripPassword }, () => {
      navigateTo(uuid);
    });
  }
}

function showHubView() {
  document.getElementById("view-hub").style.display = "block";
  document.getElementById("view-trip").style.display = "none";
  document.getElementById("currentTripIndicator").style.display = "none";
}

function showTripView() {
  currentFoodFilter = "all";
  currentShoppingFilter = "all";
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

      // 若已有登入憑證但即將逾期，嘗試無感自動續期
      if (idToken && isTokenExpired(idToken)) {
        try {
          google.accounts.id.prompt();
        } catch (err) {}
      }
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

// JWT Token 解析輔助函數
function parseJwt(token) {
  try {
    if (!token) return null;
    const base64Url = token.split(".")[1];
    if (!base64Url) return null;
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

// 檢查 Token 是否已經過期（提前 60 秒視為過期，保留網路緩衝時間）
function isTokenExpired(token) {
  if (!token) return true;
  const payload = parseJwt(token);
  if (!payload || !payload.exp) return true;
  return Date.now() >= (payload.exp * 1000 - 60000);
}

function updateAuthUI() {
  const badge = document.getElementById("userRoleBadge");
  const loginBtn = document.getElementById("customLoginBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const adminHubActions = document.getElementById("adminHubActions");

  if (!badge) return;

  if (idToken) {
    const userInfo = parseJwt(idToken);
    const userName = userInfo?.name || userInfo?.email?.split("@")[0] || "使用者";
    const expired = isTokenExpired(idToken);

    if (loginBtn) loginBtn.style.display = "none";
    if (logoutBtn) logoutBtn.style.display = "inline-flex";

    if (userRole === "admin") {
      badge.className = "user-badge badge-admin";
      if (expired) {
        // 憑證過期但本地為管理員：保留管理員視覺與編輯權限，並貼心提示點擊一鍵續期
        badge.innerHTML = `👑 管理員 (${escapeHtml(userName)}) <span style="font-size:11px;opacity:0.9;text-decoration:underline;cursor:pointer;margin-left:4px;" onclick="triggerGoogleLogin()">[憑證已逾期，點此續期]</span>`;
      } else {
        badge.innerText = `👑 管理員 (${userName})`;
      }
      if (adminHubActions) adminHubActions.style.display = "block";
    } else if (userRole === "user") {
      badge.className = "user-badge badge-user";
      if (expired) {
        badge.innerHTML = `👤 團員 (${escapeHtml(userName)}) <span style="font-size:11px;opacity:0.9;text-decoration:underline;cursor:pointer;margin-left:4px;" onclick="triggerGoogleLogin()">[憑證已逾期，點此續期]</span>`;
      } else {
        badge.innerText = `👤 團員 (${userName})`;
      }
      if (adminHubActions) adminHubActions.style.display = "none";
    } else {
      // 若後端判定 guest 或 Token 驗證逾期，絕不能誤標為「團員」
      badge.className = "user-badge badge-guest";
      badge.innerHTML = `⚠️ 登入已逾期 (${escapeHtml(userName)}) <span style="font-size:11px;text-decoration:underline;cursor:pointer;margin-left:4px;" onclick="triggerGoogleLogin()">[點此重新登入]</span>`;
      if (adminHubActions) adminHubActions.style.display = "none";
      if (loginBtn) loginBtn.style.display = "inline-flex";
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
  localStorage.removeItem("cache_userRole");
  updateAuthUI();
  showToast("已成功登出");
  fetchTrips();
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
      // 權限保護機制：若本地原先為 admin，而後端回傳 guest，且本地 Token 已逾期，則保留 admin 標記並提示續期，絕不誤降級為 guest
      if (result.role) {
        if (userRole === "admin" && result.role === "guest" && isTokenExpired(idToken)) {
          console.warn("後端判定為 guest，但本地為 admin 且 Token 逾期，保留 admin 狀態並提示續期");
        } else {
          userRole = result.role;
        }
      } else {
        userRole = "guest";
      }
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
      const hasPassword = Boolean(t.password && String(t.password).trim());
      const isUnlocked = isTripUnlocked(t.uuid, t.password);

      let lockBadge = "";
      if (hasPassword) {
        if (userRole === "admin") {
          lockBadge = '<span style="font-size:10px;background:rgba(197,160,89,0.18);color:#6B5A2A;padding:2px 8px;border-radius:12px;font-weight:800;border:1px solid var(--gold);">👑 管理員免密</span>';
        } else if (isUnlocked) {
          lockBadge = '<span style="font-size:10px;background:rgba(26,56,34,0.12);color:var(--moss);padding:2px 8px;border-radius:12px;font-weight:800;">🔓 已解鎖</span>';
        } else {
          lockBadge = '<span style="font-size:10px;background:rgba(200,59,43,0.12);color:var(--red);padding:2px 8px;border-radius:12px;font-weight:800;">🔒 密碼保護</span>';
        }
      }

      const btnText = hasPassword && !isUnlocked && userRole !== "admin" ? "輸入密碼解鎖 ➔" : "開啟手冊 ➔";

      return `
        <div class="trip-hub-card" onclick="openTripByUuid('${safeUuid}')">
          <div class="hub-card-cover-wrap">
            <img class="hub-card-cover" src="${coverInfo.url}" loading="lazy" referrerpolicy="no-referrer" onerror="handleImgError(this)">
            <div class="hub-card-tag">${coverInfo.tag}</div>
          </div>
          <div class="hub-card-body">
            <div>
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:4px;">
                <div class="hub-card-title">${safeName}</div>
                ${lockBadge}
              </div>
              <div class="hub-card-uuid">ID: ${safeUuid}</div>
              <div class="hub-card-meta">
                <div>📖 包含每日行程、航班住宿、美食口袋、代購清單</div>
              </div>
            </div>
            <div class="hub-card-btn">${btnText}</div>
          </div>
        </div>
      `;
    })
    .join("");

  container.innerHTML = cardsHtml;
}

// 行程景點時段智能評分 (將上午/下午/晚上/具體時間轉換為分鐘數進行穩定排序)
function getItineraryTimeScore(timeStr) {
  if (!timeStr) return 999999;
  const str = String(timeStr).trim().toLowerCase();
  if (!str) return 999999;

  // 1. 檢查具體時間 (支援: 09:30, 9:30, 14:00~16:00, 下午2:30, 晚上8點 等)
  const isPm = str.includes("下午") || str.includes("晚上") || str.includes("pm") || str.includes("夜間") || str.includes("黃昏") || str.includes("傍晚");
  const isAm = str.includes("上午") || str.includes("早上") || str.includes("清晨") || str.includes("am") || str.includes("早晨");

  const timeMatch = str.match(/(\d{1,2})[:：點](\d{1,2})?/) || str.match(/(\d{1,2})\s*(?:點|時)/);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    let minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : (str.includes("半") ? 30 : 0);

    if (isPm && hours < 12) {
      hours += 12;
    } else if (isAm && hours === 12) {
      hours = 0;
    }

    if (hours >= 0 && hours <= 24 && minutes >= 0 && minutes < 60) {
      return hours * 60 + minutes;
    }
  }

  // 2. 時段中文詞彙權重對應
  if (str.includes("全天") || str.includes("整天")) return 300; // 05:00 (全天概覽排在最前面)
  if (str.includes("清晨") || str.includes("早晨")) return 420; // 07:00
  if (str.includes("早上")) return 480;                         // 08:00
  if (str.includes("上午")) return 540;                         // 09:00
  if (str.includes("中午") || str.includes("午餐") || str.includes("午膳")) return 720; // 12:00
  if (str.includes("下午")) return 840;                         // 14:00
  if (str.includes("傍晚") || str.includes("黃昏")) return 1050; // 17:30
  if (str.includes("晚上") || str.includes("晚餐")) return 1140; // 19:00
  if (str.includes("夜間") || str.includes("宵夜") || str.includes("深夜")) return 1320; // 22:00

  return 999999;
}

// 對景點陣列進行穩定時段排序 (上午 < 下午 < 晚上)
function sortDayItems(items) {
  if (!Array.isArray(items) || items.length <= 1) return items || [];
  return items.sort((a, b) => {
    const scoreA = getItineraryTimeScore(a.time);
    const scoreB = getItineraryTimeScore(b.time);
    return scoreA - scoreB;
  });
}

// 智能依照 Day 序號 (Day 1 < Day 2 < Day 8) 或日期升冪排序
function sortTripDays(days) {
  if (!Array.isArray(days) || days.length === 0) return days || [];

  // 自動檢測並校正每一天的景點時段順序 (若有上午排在下午後面的情況，自動重新排序)
  days.forEach((d) => {
    if (d && Array.isArray(d.items) && d.items.length > 1) {
      let hasInversion = false;
      for (let k = 0; k < d.items.length - 1; k++) {
        if (getItineraryTimeScore(d.items[k].time) > getItineraryTimeScore(d.items[k + 1].time)) {
          hasInversion = true;
          break;
        }
      }
      if (hasInversion) {
        sortDayItems(d.items);
      }
    }
  });

  if (days.length <= 1) return days;

  return days.sort((a, b) => {
    // 1. 優先比對 Day 數字序號 (例如 "Day 1" vs "Day 8" vs "Day 2")
    const matchA = (a.id || "").match(/Day\s*(\d+)/i);
    const matchB = (b.id || "").match(/Day\s*(\d+)/i);
    if (matchA && matchB) {
      const numA = parseInt(matchA[1], 10);
      const numB = parseInt(matchB[1], 10);
      if (numA !== numB) return numA - numB;
    }

    // 2. 若無法從 id 取得數字，比對日期 (例如 "2月12日" vs "2月19日" vs "2/13")
    const parseDateScore = (dateStr) => {
      if (!dateStr) return 999999;
      const m = String(dateStr).match(/(\d+)\s*[月\/]\s*(\d+)/);
      if (m) {
        return parseInt(m[1], 10) * 100 + parseInt(m[2], 10);
      }
      return 999999;
    };

    const scoreA = parseDateScore(a.date);
    const scoreB = parseDateScore(b.date);
    if (scoreA !== scoreB) return scoreA - scoreB;

    // 3. 原生字串自然排序兜底
    return (a.id || "").localeCompare(b.id || "", undefined, { numeric: true, sensitivity: "base" });
  });
}

// 取得特定行程的詳細旅遊資料 (SWR 0 秒瞬間秒開快取機制)
async function fetchTripData() {
  if (!currentTripUuid) return;

  // 檢查特定行程是否受密碼保護且尚未解鎖
  function ensureTripUnlockedOrPrompt(data) {
    if (!data) return true;
    const currentMeta = tripsList.find((t) => t.uuid === currentTripUuid);
    const pwd = (data.password !== undefined ? data.password : (currentMeta ? currentMeta.password : "")) || "";
    if (isTripUnlocked(currentTripUuid, pwd)) {
      return true;
    }
    // 未解鎖狀態：隱蔽手冊畫面並彈出解鎖對話框
    openTripPasswordModal(
      { uuid: currentTripUuid, name: data.name || currentTripUuid, password: pwd },
      () => {
        initCountdown();
        render();
      },
      () => {
        navigateTo("");
      }
    );
    return false;
  }

  // 1. 優先從本地快取秒開（0.01 秒瞬間出現手冊內容，完全不用乾等轉圈圈！）
  let hasCache = false;
  try {
    const cached = localStorage.getItem("cache_trip_" + currentTripUuid);
    if (cached) {
      tripData = JSON.parse(cached);
      if (tripData && tripData.days) {
        sortTripDays(tripData.days);
      }
      hasCache = true;
      const indicator = document.getElementById("currentTripIndicator");
      if (indicator) {
        indicator.style.display = "inline-block";
        indicator.innerText = `📍 ${tripData.name || currentTripUuid}`;
      }
      if (ensureTripUnlockedOrPrompt(tripData)) {
        initCountdown();
        render();
      }
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
      // 權限保護機制：若本地為 admin 且 Token 逾期，不輕易降級為 guest
      if (result.role) {
        if (userRole === "admin" && result.role === "guest" && isTokenExpired(idToken)) {
          console.warn("後端判定為 guest，但本地為 admin 且 Token 逾期，保留 admin 狀態並提示續期");
        } else {
          userRole = result.role;
        }
      }

      if (tripData && tripData.days) {
        sortTripDays(tripData.days);
      }

      // 儲存至本地快取
      try {
        localStorage.setItem("cache_trip_" + currentTripUuid, JSON.stringify(tripData));
        localStorage.setItem("cache_userRole", userRole);
      } catch (e) {}

      updateAuthUI();

      const indicator = document.getElementById("currentTripIndicator");
      if (indicator) {
        indicator.style.display = "inline-block";
        indicator.innerText = `📍 ${tripData.name || currentTripUuid}`;
      }

      if (ensureTripUnlockedOrPrompt(tripData)) {
        initCountdown();
        render();
        if (hasCache) {
          showToast("手冊資料已同步最新 ✓");
        }
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
    // 檢查登入憑證是否過期，若過期則提示並喚醒登入彈窗續期
    if (isTokenExpired(idToken)) {
      showToast("登入憑證已過期，請先登入管理員以同步雲端");
      triggerGoogleLogin();
      return false;
    }
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

  // 自動檢測並校正當前天數景點時段順序 (若有上午排在下午後面的情況，自動重新排序)
  if (Array.isArray(day.items) && day.items.length > 1) {
    let needsSort = false;
    for (let k = 0; k < day.items.length - 1; k++) {
      if (getItineraryTimeScore(day.items[k].time) > getItineraryTimeScore(day.items[k + 1].time)) {
        needsSort = true;
        break;
      }
    }
    if (needsSort) {
      sortDayItems(day.items);
      save(); // 靜默同步正確排序至試算表與本地快取
    }
  }

  // 檢查是否有天數跳號 (例如 Day 1, Day 2, Day 4)
  let hasSkippedDays = false;
  tripData.days.forEach((d, idx) => {
    const m = (d.id || "").match(/Day\s*(\d+)/i);
    if (m && parseInt(m[1], 10) !== idx + 1) {
      hasSkippedDays = true;
    }
  });

  const dayActions = isAdmin
    ? `<div class="item-actions">
         ${hasSkippedDays ? `<button class="btn-mini" style="background:var(--gold-soft);color:#6B5A2A;border-color:var(--gold);" onclick="resequenceAllDays()" title="偵測到天數跳號，點擊自動連續編號">⚡ 連續重編天數</button>` : ""}
         <button class="btn-mini" onclick="openEditDayTitleModal(${selectedDay})">✏️ 編輯主題</button>
         ${tripData.days.length > 1
      ? `<button class="btn-mini btn-mini-danger" onclick="deleteCurrentDay(${selectedDay})">🗑️ 刪除本日</button>`
      : ""
    }
       </div>`
    : "";

  // 智能比對當日今晚入住飯店
  let tonightHotelHtml = "";
  const hotels = tripData.hotels || (tripData.hotel && tripData.hotel.name ? [tripData.hotel] : []);
  if (hotels.length > 0) {
    const currentDayNumMatch = (day.id || "").match(/Day\s*(\d+)/i);
    let currentDayIso = "";
    if (currentDayNumMatch && tripData.startDate) {
      currentDayIso = calculateIsoDateForDayNum(tripData.startDate, parseInt(currentDayNumMatch[1], 10));
    }

    let tonightHotel = null;
    if (currentDayIso) {
      // 比對 checkin <= currentDayIso < checkout
      tonightHotel = hotels.find((h) => {
        if (!h.checkin) return false;
        if (h.checkout) {
          return currentDayIso >= h.checkin && currentDayIso < h.checkout;
        }
        return currentDayIso === h.checkin;
      });
    }

    // 若無具體日期但僅有一間飯店時作為預設提示
    if (!tonightHotel && hotels.length === 1 && hotels[0].name) {
      tonightHotel = hotels[0];
    }

    if (tonightHotel && tonightHotel.name) {
      const safeHotelName = escapeHtml(tonightHotel.name);
      const safeHotelAddr = escapeHtml(tonightHotel.addr || "");
      const hotelQuery = encodeURIComponent(`${tonightHotel.name} ${tonightHotel.addr || ""}`);
      const hotelMapUrl = `https://www.google.com/maps/search/?api=1&query=${hotelQuery}`;
      tonightHotelHtml = `
        <div style="background:rgba(197,160,89,0.12);border:1px solid rgba(197,160,89,0.35);border-radius:14px;padding:10px 14px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:18px;">🏨</span>
            <div>
              <div style="font-size:13px;font-weight:800;color:var(--ink);">今晚入住：${safeHotelName}</div>
              ${safeHotelAddr ? `<div style="font-size:11px;color:#777;margin-top:2px;">📍 ${safeHotelAddr}</div>` : ""}
            </div>
          </div>
          <a class="map-link" style="margin-top:0;padding:4px 10px;font-size:11px;" href="${hotelMapUrl}" target="_blank" rel="noopener noreferrer">🗺️ 導航回飯店</a>
        </div>
      `;
    }
  }

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
      const safeLink = sanitizeUrl(item.link);

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
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:10px;">
              ${autoMapUrl
          ? `<a class="map-link" style="margin-top:0;" href="${autoMapUrl}" target="_blank" rel="noopener noreferrer">🗺 地圖導航</a>`
          : ""
        }
              ${safeLink && safeLink !== "#"
          ? `<a class="ext-link" style="margin-top:0;" href="${safeLink}" target="_blank" rel="noopener noreferrer">🔗 補充資料</a>`
          : ""
        }
            </div>
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
      ${tonightHotelHtml}
      <div class="timeline">${items ||
    '<p style="color:#888;font-size:13px;padding:10px 0;">本日尚無規劃景點，請點擊下方按鈕新增！</p>'
    }</div>
      ${addBtn}
    </div>
  `;
}

// 智慧一鍵連續重編所有天數序號 (如 Day 1, Day 2, Day 4, Day 8 重新順序排列為 Day 1 ~ Day 4)
function resequenceAllDays() {
  if (!tripData || !Array.isArray(tripData.days) || tripData.days.length <= 1) {
    showToast("目前天數無需重整序號");
    return;
  }

  openConfirmModal({
    title: "⚡ 連續重編天數序號確認",
    message: `確定要將現有 ${tripData.days.length} 天行程重新連續編號為「Day 1 ～ Day ${tripData.days.length}」嗎？系統將自動重新對齊連續日期與交通對應代號。`,
    confirmText: "確認重編序號",
    onConfirm: () => {
      // 先依原先日期與數字排序好
      sortTripDays(tripData.days);
      const tagMapping = {}; // 記錄舊交通代號 -> 新交通代號

      tripData.days.forEach((d, idx) => {
        const oldId = d.id;
        const oldDate = d.date;
        const newDayNum = idx + 1;
        const newId = `Day ${newDayNum}`;

        // 推算新日期
        let newDate = d.date;
        if (tripData.startDate) {
          const newIsoDate = calculateIsoDateForDayNum(tripData.startDate, newDayNum);
          newDate = formatDateToDisplayWithWeekday(newIsoDate);
        }

        const oldDayNumMatch = (oldId || "").match(/Day\s*(\d+)/i);
        const oldRawDate = (oldDate || "").split("（")[0].replace("月", "/").replace("日", "").trim();
        const newRawDate = (newDate || "").split("（")[0].replace("月", "/").replace("日", "").trim();

        const oldPrefix = oldDayNumMatch ? `D${oldDayNumMatch[1]}` : "";
        const newPrefix = `D${newDayNum}`;
        const oldTag = `${oldPrefix}${oldRawDate ? `-${oldRawDate}` : ""}`;
        const newTag = `${newPrefix}${newRawDate ? `-${newRawDate}` : ""}`;

        if (oldTag !== newTag) {
          tagMapping[oldTag] = newTag;
          if (oldPrefix) tagMapping[oldPrefix] = newPrefix;
        }

        d.id = newId;
        d.date = newDate;
      });

      // 同步更新交通路線中的 dayTag
      if (tripData.transport && Array.isArray(tripData.transport.routes)) {
        tripData.transport.routes.forEach((r) => {
          if (!r.dayTag) return;
          if (tagMapping[r.dayTag]) {
            r.dayTag = tagMapping[r.dayTag];
          } else {
            for (const oldPrefix in tagMapping) {
              if (r.dayTag.startsWith(`${oldPrefix}-`)) {
                r.dayTag = r.dayTag.replace(`${oldPrefix}-`, `${tagMapping[oldPrefix]}-`);
                break;
              }
            }
          }
        });
      }

      sortTripDays(tripData.days);
      if (selectedDay >= tripData.days.length) selectedDay = 0;
      renderItinerary();
      save();
      showToast(`已成功將天數重整為 Day 1 ～ Day ${tripData.days.length}！`);
    },
  });
}

// =========================================================================
// 行程天數與日期星期智能換算輔助函式
// =========================================================================

// 將 ISO 日期 (YYYY-MM-DD) 轉換為繁體中文格式「X月X日（星期幾）」
function formatDateToDisplayWithWeekday(isoDateStr) {
  if (!isoDateStr) return "";
  const parts = isoDateStr.split("-");
  if (parts.length < 3) return "";
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  const dt = new Date(y, m - 1, d);
  if (isNaN(dt.getTime())) return "";
  const weekDays = ["日", "一", "二", "三", "四", "五", "六"];
  return `${m}月${d}日（${weekDays[dt.getDay()]}）`;
}

// 根據行程出發日期與第 N 天計算對應的 YYYY-MM-DD
function calculateIsoDateForDayNum(startDateStr, dayNum) {
  if (!startDateStr || !dayNum || dayNum < 1) return "";
  const base = new Date(startDateStr + "T00:00:00");
  if (isNaN(base.getTime())) return "";
  base.setDate(base.getDate() + (dayNum - 1));
  const y = base.getFullYear();
  const m = String(base.getMonth() + 1).padStart(2, "0");
  const d = String(base.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// 根據行程出發日期與目標日期計算是第幾天 (Day N)
function calculateDayNumFromDate(startDateStr, targetDateStr) {
  if (!startDateStr || !targetDateStr) return null;
  const start = new Date(startDateStr + "T00:00:00");
  const target = new Date(targetDateStr + "T00:00:00");
  if (isNaN(start.getTime()) || isNaN(target.getTime())) return null;
  const diffDays = Math.round((target - start) / (1000 * 60 * 60 * 24));
  return diffDays + 1;
}

// 智慧推算建議的下一個天數編號 (若有中間缺漏如 1, 2, 4 缺 3，優先建議填補 3)
function getSuggestedNextDayNum(days) {
  if (!Array.isArray(days) || days.length === 0) return 1;
  const existingNums = new Set();
  days.forEach((d) => {
    const m = (d.id || "").match(/Day\s*(\d+)/i);
    if (m) existingNums.add(parseInt(m[1], 10));
  });

  for (let n = 1; n <= 30; n++) {
    if (!existingNums.has(n)) return n;
  }
  return days.length + 1;
}

// 全域彈窗連動回呼：新增天數時由日曆選取器同步天數與星期文字
window.onAddDayPickerChange = function (newDateStr) {
  if (!newDateStr) return;
  const chineseDate = formatDateToDisplayWithWeekday(newDateStr);
  const dateInput = document.getElementById("addDayDate");
  if (dateInput) dateInput.value = chineseDate;

  // 若有出發日期，自動反推並同步選取天數下拉選單
  if (tripData && tripData.startDate) {
    const dayNum = calculateDayNumFromDate(tripData.startDate, newDateStr);
    if (dayNum && dayNum >= 1 && dayNum <= 14) {
      const select = document.getElementById("addDayId");
      if (select) select.value = `Day ${dayNum}`;
    }
  }
};

// 全域彈窗連動回呼：新增天數時由下拉選單同步日曆與星期文字
window.onAddDaySelectChange = function (val) {
  if (!val) return;
  const m = val.match(/Day\s*(\d+)/i) || val.match(/^(\d+)$/);
  if (m && tripData && tripData.startDate) {
    const dayNum = parseInt(m[1], 10);
    const isoDate = calculateIsoDateForDayNum(tripData.startDate, dayNum);
    if (isoDate) {
      const picker = document.getElementById("addDayPicker");
      if (picker) picker.value = isoDate;
      const chineseDate = formatDateToDisplayWithWeekday(isoDate);
      const dateInput = document.getElementById("addDayDate");
      if (dateInput) dateInput.value = chineseDate;
    }
  }
};

// 全域彈窗連動回呼：編輯天數時由日曆選取器同步星期文字
window.onEditDayPickerChange = function (newDateStr) {
  if (!newDateStr) return;
  const chineseDate = formatDateToDisplayWithWeekday(newDateStr);
  const dateInput = document.getElementById("editDayDate");
  if (dateInput) dateInput.value = chineseDate;
};

// 新增行程天數對話框
function openAddDayModal() {
  if (!tripData.days) tripData.days = [];
  const nextDayNum = Math.min(getSuggestedNextDayNum(tripData.days), 14);
  const nextDayId = `Day ${nextDayNum}`;

  // 自動推算預設日期
  let defaultIsoDate = "";
  let defaultDateText = "";
  if (tripData.startDate) {
    defaultIsoDate = calculateIsoDateForDayNum(tripData.startDate, nextDayNum);
    defaultDateText = formatDateToDisplayWithWeekday(defaultIsoDate);
  }

  // 內建 14 天選項
  let presetOptions = "";
  for (let d = 1; d <= 14; d++) {
    presetOptions += `<option value="Day ${d}" ${d === nextDayNum ? "selected" : ""}>Day ${d}</option>`;
  }

  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">天數識別 (內建 14 天) <span style="color:var(--red);">*</span></div>
      <select id="addDayId" class="ef-select" onchange="window.onAddDaySelectChange(this.value)">
        ${presetOptions}
      </select>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">選擇日期 (點選日曆，系統自動計算日期與星期)</div>
      <input type="date" id="addDayPicker" class="ef-input" value="${defaultIsoDate}" onchange="window.onAddDayPickerChange(this.value)">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">日期文字說明 (依日曆自動生成，可自由微調)</div>
      <input type="text" id="addDayDate" class="ef-input" value="${defaultDateText}" placeholder="例如: 2月16日（一）">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">當日行程主題名稱 <span style="color:var(--red);">*</span></div>
      <input type="text" id="addDayTitle" class="ef-input" placeholder="例如: 岡山城 ＆ 後樂園漫遊">
    </div>
  `;

  openFormModal({
    title: `➕ 新增行程天數`,
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

      sortTripDays(tripData.days);
      const newIdx = tripData.days.findIndex((d) => d.id === dayId);
      selectedDay = newIdx !== -1 ? newIdx : tripData.days.length - 1;
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
      sortTripDays(tripData.days);
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
  
  // 嘗試從現有日期文字反推 ISO 日期
  let currentIsoDate = "";
  const m = (day.id || "").match(/Day\s*(\d+)/i);
  if (m && tripData.startDate) {
    currentIsoDate = calculateIsoDateForDayNum(tripData.startDate, parseInt(m[1], 10));
  }

  let editPresetOptions = "";
  for (let d = 1; d <= 14; d++) {
    const dayVal = `Day ${d}`;
    editPresetOptions += `<option value="${dayVal}" ${dayVal === day.id ? "selected" : ""}>${dayVal}</option>`;
  }

  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">天數識別 (內建 14 天) <span style="color:var(--red);">*</span></div>
      <select id="editDayId" class="ef-select" onchange="window.onAddDaySelectChange ? window.onAddDaySelectChange(this.value) : null">
        ${editPresetOptions}
      </select>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">選擇日期 (更換日期自動重算星期)</div>
      <input type="date" id="editDayPicker" class="ef-input" value="${currentIsoDate}" onchange="window.onEditDayPickerChange(this.value)">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">日期文字 (依日曆自動更新，例如: 2月13日（五）)</div>
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

      const oldId = day.id;
      const oldDate = day.date;

      tripData.days[dayIdx].id = id;
      tripData.days[dayIdx].title = title;
      tripData.days[dayIdx].date = date;

      // 智慧連動：當天數序號或日期變更時，自動批次更新交通路線中的對應天數標籤
      const oldDayNumMatch = (oldId || "").match(/Day\s*(\d+)/i);
      const newDayNumMatch = (id || "").match(/Day\s*(\d+)/i);
      const oldRawDate = (oldDate || "").split("（")[0].replace("月", "/").replace("日", "").trim();
      const newRawDate = (date || "").split("（")[0].replace("月", "/").replace("日", "").trim();

      const oldPrefix = oldDayNumMatch ? `D${oldDayNumMatch[1]}` : "";
      const newPrefix = newDayNumMatch ? `D${newDayNumMatch[1]}` : "";
      const oldTag = `${oldPrefix}${oldRawDate ? `-${oldRawDate}` : ""}`;
      const newTag = `${newPrefix}${newRawDate ? `-${newRawDate}` : ""}`;

      if (oldTag && newTag && oldTag !== newTag && tripData.transport && Array.isArray(tripData.transport.routes)) {
        let updatedCount = 0;
        tripData.transport.routes.forEach((r) => {
          if (!r.dayTag) return;
          if (r.dayTag === oldTag) {
            r.dayTag = newTag;
            updatedCount++;
          } else if (oldPrefix && (r.dayTag === oldPrefix || r.dayTag.startsWith(`${oldPrefix}-`))) {
            r.dayTag = r.dayTag.replace(new RegExp(`^${oldPrefix}\\b`), newPrefix);
            if (oldRawDate && newRawDate) {
              r.dayTag = r.dayTag.replace(oldRawDate, newRawDate);
            }
            updatedCount++;
          }
        });
        if (updatedCount > 0) {
          showToast(`已同步更新 ${updatedCount} 筆對應交通路線之天數標籤 (${oldTag} ➔ ${newTag})`);
        }
      }

      sortTripDays(tripData.days);
      const editedIdx = tripData.days.findIndex((d) => d.id === id);
      selectedDay = editedIdx !== -1 ? editedIdx : 0;

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
      <div class="ef-label">參考網址 / 補充資料 (景點官網、門票預約、介紹等，選填)</div>
      <input type="text" id="editItLink" class="ef-input" placeholder="https://..." value="${item.link || ""}">
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
      tripData.days[dayIdx].items[itemIdx].link = document
        .getElementById("editItLink")
        .value.trim();
      tripData.days[dayIdx].items[itemIdx].desc = document
        .getElementById("editItDesc")
        .value.trim();
      tripData.days[dayIdx].items[itemIdx].imgUrl = formatDriveImageUrl(
        document.getElementById("editItImgUrl").value.trim()
      );

      // 編輯景點時段後，自動依時段重新排序
      sortDayItems(tripData.days[dayIdx].items);

      renderItinerary();
      save();
      return true;
    },
  });
}

// 純前端 Canvas 智能高畫質圖片壓縮 (自動將 5~10MB 大圖等比縮放並無損壓縮至 200~400KB)
function compressImage(file, maxWidth = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) {
      return resolve(null);
    }

    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        // 計算等比縮放尺寸 (最大邊長不超過 1600px，手機/電腦 Retina 螢幕細節極其完美)
        if (width > maxWidth || height > maxWidth) {
          if (width > height) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          } else {
            width = Math.round((width * maxWidth) / height);
            height = maxWidth;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        // 轉換為品質 82% 的 JPEG 格式 (體積減少 90% 以上，畫質近乎無損)
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              return resolve({
                base64: e.target.result.split(",")[1],
                mimeType: file.type,
              });
            }
            const compressedReader = new FileReader();
            compressedReader.onload = () => {
              const base64 = compressedReader.result.split(",")[1];
              resolve({
                base64: base64,
                mimeType: "image/jpeg",
                size: blob.size,
              });
            };
            compressedReader.readAsDataURL(blob);
          },
          "image/jpeg",
          quality
        );
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
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

  // 權限與憑證檢查
  if (isTokenExpired(idToken)) {
    showToast("登入憑證已逾期，請先登入管理員以授權上傳照片");
    triggerGoogleLogin();
    return;
  }

  const previewDiv = document.getElementById(previewDivId);
  previewDiv.innerHTML =
    "<span style='font-size:12px;color:var(--moss);'>⏳ 圖片智能壓縮中...</span>";
  showToast("正在智能壓縮並上傳照片...");

  try {
    // 1. 本地純前端瞬間壓縮 (將 5~10MB 大圖壓縮至 200~400KB)
    const compressed = await compressImage(file, 1600, 0.82);
    const base64Data = compressed
      ? compressed.base64
      : await new Promise((res) => {
          const r = new FileReader();
          r.onload = (e) => res(e.target.result.split(",")[1]);
          r.readAsDataURL(file);
        });

    previewDiv.innerHTML =
      "<span style='font-size:12px;color:var(--moss);'>⏳ 雲端同步上傳中...</span>";

    // 2. 上傳至 Google 雲端硬碟
    const res = await fetch(GAS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "uploadImage",
        token: idToken,
        tripUuid: currentTripUuid,
        filename: file.name.replace(/\.[^/.]+$/, "") + ".jpg",
        mimeType: compressed ? compressed.mimeType : file.type,
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
    console.error("上傳異常:", e);
    alert("上傳異常，請檢查網路連線");
    previewDiv.innerHTML = "";
  }
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

// 手動調整景點前後順序 (上移 / 下移)
function moveItineraryItem(dayIdx, itemIdx, offset) {
  const day = tripData && tripData.days && tripData.days[dayIdx];
  if (!day || !Array.isArray(day.items)) return;
  const targetIdx = itemIdx + offset;
  if (targetIdx < 0 || targetIdx >= day.items.length) return;

  const item = day.items.splice(itemIdx, 1)[0];
  day.items.splice(targetIdx, 0, item);
  renderItinerary();
  save();
  showToast("已調整景點順序");
}

// 依時段自動排序當日所有景點
function autoSortCurrentDayItems(dayIdx) {
  const day = tripData && tripData.days && tripData.days[dayIdx];
  if (!day || !Array.isArray(day.items) || day.items.length <= 1) {
    showToast("景點數量無需排序");
    return;
  }
  sortDayItems(day.items);
  renderItinerary();
  save();
  showToast("已依時段順序重新排列！");
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
      <div class="ef-label">參考網址 / 補充資料 (景點官網、門票預約、介紹等，選填)</div>
      <input type="text" id="addItineraryLink" class="ef-input" placeholder="https://...">
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
      const link = document.getElementById("addItineraryLink").value.trim();
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
        link: link || "",
        desc: desc,
        imgUrl: imgUrl || "",
      });

      // 新增景點後自動依時段重新排序，確保時間軸早中晚順序井然
      sortDayItems(tripData.days[dayIdx].items);

      renderItinerary();
      save();
      return true;
    },
  });
}

// =========================================================================
// 4. 美食清單 (Food) - 地區/必吃快速分類標籤、微編輯、地圖導航、照片上傳與即時同步
// =========================================================================
// 智慧提取或辨識美食所屬地區 (優先使用自訂 area，次之從名稱或說明辨識常見地區關鍵字)
function extractFoodArea(item) {
  if (!item) return "";
  if (item.area && item.area.trim()) {
    return item.area.trim();
  }
  const fullText = `${item.name || ""} ${item.desc || ""}`;
  const commonAreas = ["岡山", "倉敷", "高松", "小豆島", "兒島", "廣島", "尾道", "松山", "直島", "豐島", "丸龜", "琴平"];
  for (const a of commonAreas) {
    if (fullText.includes(a)) {
      return a;
    }
  }
  return "";
}

function setFoodFilter(filterId) {
  currentFoodFilter = filterId;
  renderFood();
}

function renderFood() {
  if (!tripData) return;
  const list = tripData.food || [];
  const isAdmin = userRole === "admin";

  const totalCount = list.length;
  const mustCount = list.filter((it) => it.must).length;
  const todoCount = list.filter((it) => !it.done).length;
  const doneCount = list.filter((it) => it.done).length;

  // 統計所有地區分組與數量
  const areaCounts = {};
  list.forEach((it) => {
    const a = extractFoodArea(it);
    if (a) {
      areaCounts[a] = (areaCounts[a] || 0) + 1;
    }
  });
  const areas = Object.keys(areaCounts).sort((a, b) => areaCounts[b] - areaCounts[a]);

  // 構建分類膠囊按鈕清單
  const foodFilters = [
    { id: "all", label: `全部 (${totalCount})` },
    ...(mustCount > 0 ? [{ id: "must", label: `🔥 必吃 (${mustCount})` }] : []),
    ...areas.map((a) => ({ id: `area:${a}`, label: `📍 ${a} (${areaCounts[a]})` })),
    { id: "todo", label: `⏳ 想吃 (${todoCount})` },
    { id: "done", label: `✅ 已品嚐 (${doneCount})` },
  ];

  // 膠囊過濾列 HTML
  const filterHtml = totalCount > 0 ? `
    <div class="filter-scroll-row">
      ${foodFilters.map((f) => `
        <button type="button" class="filter-pill ${currentFoodFilter === f.id ? "active" : ""}" onclick="setFoodFilter('${f.id}')">
          ${f.label}
        </button>
      `).join("")}
    </div>
  ` : "";

  // 依條件過濾並保留原陣列索引 (確保修改、刪除、品嚐狀態操作正確)
  const filteredItems = list
    .map((item, originalIndex) => ({ item, originalIndex }))
    .filter(({ item }) => {
      if (currentFoodFilter === "all") return true;
      if (currentFoodFilter === "must") return !!item.must;
      if (currentFoodFilter === "todo") return !item.done;
      if (currentFoodFilter === "done") return !!item.done;
      if (currentFoodFilter.startsWith("area:")) {
        const targetArea = currentFoodFilter.substring(5);
        return extractFoodArea(item) === targetArea;
      }
      return true;
    });

  const itemsHtml = filteredItems
    .map(({ item, originalIndex: i }) => {
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
      const detectedArea = extractFoodArea(item);

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
                  ${detectedArea
          ? `<span style="font-size:10px;background:rgba(26,56,34,0.1);color:var(--moss);padding:2px 6px;border-radius:4px;vertical-align:middle;font-weight:600;margin-left:4px;">📍 ${escapeHtml(detectedArea)}</span>`
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

  let listContent = "";
  if (totalCount === 0) {
    listContent = '<p style="color:#888;padding:12px 0;">尚未加入美食口袋名單</p>';
  } else if (filteredItems.length === 0) {
    listContent = '<p style="color:#888;padding:16px 0;text-align:center;">此分類條件下尚無符合的美食項目</p>';
  } else {
    listContent = itemsHtml;
  }

  document.getElementById("page-food").innerHTML = `
    <div class="card">
      <div class="card-header">
        <div>
          <span class="card-title">🍽 旅遊口袋名單</span>
          <div style="font-size:11px;color:var(--gold);font-weight:700;margin-top:2px;">
            共 ${totalCount} 筆口袋名單 ｜ 已品嚐 ${doneCount} 筆
          </div>
        </div>
      </div>
      ${filterHtml}
      ${listContent}
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
      <div class="ef-label">地區/分區 (例如: 岡山、倉敷、高松、小豆島，選填)</div>
      <input type="text" id="editFoodArea" class="ef-input" placeholder="例如: 岡山、倉敷、高松" value="${item.area || extractFoodArea(item) || ""}">
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
      tripData.food[index].area = document
        .getElementById("editFoodArea")
        .value.trim();
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
      <div class="ef-label">地區/分區 (例如: 岡山、倉敷、高松、小豆島，選填)</div>
      <input type="text" id="addFoodArea" class="ef-input" placeholder="例如: 岡山、倉敷、高松">
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
      const area = document.getElementById("addFoodArea").value.trim();
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
        area: area,
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
// 5. 代購商品 (Shopping) - 依委託人/未買狀態膠囊過濾、數量、商品、地點(Google Maps)、價格、網址、照片與採買狀態
// =========================================================================
function setShoppingFilter(filterId) {
  currentShoppingFilter = filterId;
  renderShopping();
}

function renderShopping() {
  if (!tripData) return;
  const list = tripData.shopping || [];
  const isAdmin = userRole === "admin";

  const totalCount = list.length;
  const doneCount = list.filter((it) => it.done).length;
  const todoCount = totalCount - doneCount;

  // 統計各委託人的代購件數
  const buyerCounts = {};
  list.forEach((it) => {
    const b = (it.buyer || "").trim() || "未指定";
    buyerCounts[b] = (buyerCounts[b] || 0) + 1;
  });
  const buyers = Object.keys(buyerCounts).sort((a, b) => buyerCounts[b] - buyerCounts[a]);

  // 構建膠囊過濾按鈕清單
  const shoppingFilters = [
    { id: "all", label: `全部 (${totalCount})` },
    ...(todoCount > 0 ? [{ id: "todo", label: `⏳ 未購買 (${todoCount})` }] : []),
    ...(doneCount > 0 ? [{ id: "done", label: `✅ 已買齊 (${doneCount})` }] : []),
    ...buyers.map((b) => ({ id: `buyer:${b}`, label: `👤 ${b} (${buyerCounts[b]})` })),
  ];

  // 膠囊過濾列 HTML
  const filterHtml = totalCount > 0 ? `
    <div class="filter-scroll-row">
      ${shoppingFilters.map((f) => `
        <button type="button" class="filter-pill ${currentShoppingFilter === f.id ? "active" : ""}" onclick="setShoppingFilter('${f.id}')">
          ${f.label}
        </button>
      `).join("")}
    </div>
  ` : "";

  // 依篩選條件過濾並保留原陣列索引
  const filteredItems = list
    .map((item, originalIndex) => ({ item, originalIndex }))
    .filter(({ item }) => {
      if (currentShoppingFilter === "all") return true;
      if (currentShoppingFilter === "todo") return !item.done;
      if (currentShoppingFilter === "done") return !!item.done;
      if (currentShoppingFilter.startsWith("buyer:")) {
        const targetBuyer = currentShoppingFilter.substring(6);
        const b = (item.buyer || "").trim() || "未指定";
        return b === targetBuyer;
      }
      return true;
    });

  const itemsHtml = filteredItems
    .map(({ item, originalIndex: i }) => {
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
    ? `<button class="glass-btn" style="background:var(--moss-gradient);color:#fff;width:100%;margin-top:16px;justify-content:center;" onclick="openAddShoppingModal()">＋ 新增代購商品</button>`
    : "";

  let listContent = "";
  if (totalCount === 0) {
    listContent = '<p style="color:#888;font-size:13px;padding:10px 0;">目前尚未新增任何代購商品，請點擊下方按鈕新增！</p>';
  } else if (filteredItems.length === 0) {
    listContent = '<p style="color:#888;font-size:13px;padding:16px 0;text-align:center;">此分類條件下尚無符合的代購商品</p>';
  } else {
    listContent = itemsHtml;
  }

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
      ${filterHtml}
      ${listContent}
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
        <div>🔐 存取密碼: <span style="font-family:monospace;font-size:11px;background:#F9F9F9;padding:1px 6px;border-radius:4px;color:var(--moss);font-weight:bold;">${escapeHtml(t.password || "未設密碼 (公開手冊)")}</span></div>
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
    <div class="ef-wrap">
      <div class="ef-label">🔐 旅程專屬存取密碼 <span style="font-weight:normal;color:#888;">(選填，留空為公開手冊，有設密碼訪客需輸入密碼唯讀)</span></div>
      <input type="text" id="newTripPassword" class="ef-input" placeholder="例如: okayama2027 (選填)">
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
      const password = document.getElementById("newTripPassword").value.trim();
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

      if (isTokenExpired(idToken)) {
        showToast("登入憑證已逾期，請先登入管理員以建立行程");
        triggerGoogleLogin();
        return false;
      }

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
            password,
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
    <div class="ef-wrap">
      <div class="ef-label">🔐 旅程專屬存取密碼 <span style="font-weight:normal;color:#888;">(選填，留空即取消密碼變為公開手冊)</span></div>
      <input type="text" id="editTripPassword" class="ef-input" value="${trip.password || ""}" placeholder="例如: okayama2027 (選填)">
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
      const password = document.getElementById("editTripPassword").value.trim();
      let allowedUsers = document
        .getElementById("editTripAllowedUsers")
        .value.trim();

      if (!name) {
        alert("行程名稱不得為空！");
        return false;
      }

      allowedUsers = allowedUsers.replace(/，/g, ",");

      if (isTokenExpired(idToken)) {
        showToast("登入憑證已逾期，請先登入管理員以儲存設定");
        triggerGoogleLogin();
        return false;
      }

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
            password,
          }),
        });
        const result = await res.json();
        if (result.status === "success") {
          showToast("行程設定更新成功 ✓");
          trip.password = password;
          // 若修改的是當前行程，同步更新記憶體資料
          if (currentTripUuid === uuid && tripData) {
            tripData.name = name;
            tripData.startDate = startDate;
            tripData.endDate = endDate;
            tripData.duration = duration;
            tripData.password = password;
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
// 2.5 交通模組 (Transport) - 多張路線地圖相簿、周遊券與每日乘車時間軸
// =========================================================================

// 全局當前相簿燈箱瀏覽索引
let currentLightboxMapIdx = 0;

// 規範化與向後相容交通資料結構
function ensureTransportData() {
  if (!tripData) return;
  if (!tripData.transport) {
    tripData.transport = { maps: [], passes: [], routes: [] };
  }
  if (!Array.isArray(tripData.transport.maps)) {
    tripData.transport.maps = [];
  }
  // 向下相容單張 mapImgUrl
  if (tripData.transport.mapImgUrl && tripData.transport.maps.length === 0) {
    tripData.transport.maps.push({
      id: uid(),
      title: tripData.transport.mapNote || "主要交通路線圖",
      url: tripData.transport.mapImgUrl,
      note: tripData.transport.mapNote || "主要交通路線圖",
    });
  }
  if (!Array.isArray(tripData.transport.passes)) tripData.transport.passes = [];
  if (!Array.isArray(tripData.transport.routes)) tripData.transport.routes = [];
}

function renderTransport() {
  if (!tripData) return;
  ensureTransportData();
  const transport = tripData.transport;
  const isAdmin = userRole === "admin";
  const routes = transport.routes || [];
  const passes = transport.passes || [];
  const maps = transport.maps || [];

  // 計算預估每人總交通費用
  let totalCostYen = 0;
  let totalCostNtd = 0;

  // 加總周遊券費用
  passes.forEach((p) => {
    const costNum = parseFloat(String(p.cost || "").replace(/[^0-9.]/g, "")) || 0;
    if (p.currency === "NTD" || String(p.cost).includes("NT") || String(p.cost).includes("台幣")) {
      totalCostNtd += costNum;
    } else {
      totalCostYen += costNum;
    }
  });

  // 加總各段車資
  routes.forEach((r) => {
    const costNum = parseFloat(String(r.cost || "").replace(/[^0-9.]/g, "")) || 0;
    if (r.currency === "NTD" || String(r.cost).includes("NT") || String(r.cost).includes("台幣")) {
      totalCostNtd += costNum;
    } else {
      totalCostYen += costNum;
    }
  });

  // 1. 交通路線地圖相簿區塊 (智慧切換：單張時高清展示，多張時網格相簿，0張時友善引導)
  let mapContentHtml = "";
  
  if (maps.length === 1) {
    const m = maps[0];
    const safeTitle = escapeHtml(m.title || "主要交通路線圖");
    const safeNote = escapeHtml(m.note || "");
    const safeUrl = sanitizeUrl(m.url);
    const adminActions = isAdmin
      ? `
        <div class="item-actions">
          <button class="btn-mini" style="background:var(--moss);color:#FFF;padding:5px 12px;" onclick="openAddRouteMapModal()">＋ 新增第 2 張地圖</button>
          <button class="btn-mini" onclick="openEditRouteMapModal(0)">✏️ 更換此圖</button>
          <button class="btn-mini btn-mini-danger" onclick="deleteRouteMap(0)">🗑️ 刪除此圖</button>
        </div>
      `
      : "";

    mapContentHtml = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div>
          <span class="card-title">🗺️ ${safeTitle}</span>
          ${safeNote ? `<div style="font-size:12px;color:var(--gold);font-weight:700;margin-top:2px;">${safeNote}</div>` : ""}
        </div>
        ${adminActions}
      </div>
      <div class="route-map-preview-wrap" onclick="openMapLightbox(0)">
        <img src="${safeUrl}" class="route-map-preview" referrerpolicy="no-referrer" loading="lazy" onerror="handleImgError(this)" alt="${safeTitle}">
        <div class="route-map-zoom-tip">🔍 點擊放大查看高清全圖</div>
      </div>
    `;
  } else if (maps.length > 1) {
    const adminHeaderAction = isAdmin
      ? `<button class="btn-mini" style="background:var(--moss);color:#FFF;padding:5px 12px;" onclick="openAddRouteMapModal()">＋ 新增路線圖</button>`
      : "";

    mapContentHtml = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div>
          <span class="card-title">🗺️ 旅程交通地圖相簿</span>
          <div style="font-size:12px;color:var(--gold);font-weight:700;margin-top:2px;">已收藏 ${maps.length} 張交通路線圖 (點擊查看高清大圖與切換)</div>
        </div>
        ${adminHeaderAction}
      </div>
      <div class="route-maps-grid">
        ${maps.map((m, idx) => {
          const safeTitle = escapeHtml(m.title || `路線圖 ${idx + 1}`);
          const safeNote = escapeHtml(m.note || "");
          const safeUrl = sanitizeUrl(m.url);
          const adminMapActions = isAdmin
            ? `
              <div class="item-actions" onclick="event.stopPropagation()">
                <button class="btn-mini" onclick="openEditRouteMapModal(${idx})">✏️ 編輯</button>
                <button class="btn-mini btn-mini-danger" onclick="deleteRouteMap(${idx})">🗑️ 刪除</button>
              </div>
            `
            : "";

          return `
            <div class="route-map-card-item">
              <div class="route-map-thumb-wrap" onclick="openMapLightbox(${idx})">
                <img src="${safeUrl}" class="route-map-thumb" referrerpolicy="no-referrer" loading="lazy" onerror="handleImgError(this)" alt="${safeTitle}">
                <div class="route-map-zoom-tip">🔍 點擊放大檢視</div>
              </div>
              <div class="route-map-info-body">
                <div class="route-map-title-row">
                  <div class="route-map-item-title">🗺️ ${safeTitle}</div>
                  ${adminMapActions}
                </div>
                ${safeNote ? `<div class="route-map-item-note">📝 ${safeNote}</div>` : ""}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  } else {
    // 尚未上傳任何地圖時的引導介面
    const adminUploadBtn = isAdmin
      ? `<button class="glass-btn" style="background:var(--moss-gradient);color:#fff;display:inline-flex;" onclick="openAddRouteMapModal()">＋ 上傳第一張地鐵/JR路線圖</button>`
      : "";

    mapContentHtml = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span class="card-title">🗺️ 旅程交通地圖相簿</span>
      </div>
      <div style="text-align:center;padding:36px 16px;color:#888;border:1.5px dashed var(--mist);border-radius:18px;margin-top:14px;background:rgba(255,255,255,0.4);">
        <p style="font-size:13px;margin-bottom:8px;font-weight:700;color:var(--moss);">目前尚未上傳交通路線圖</p>
        <p style="font-size:12px;color:#888;margin-bottom:12px;">可上傳地下鐵、JR 鐵路、景點觀光巴士等高清路線地圖，方便全體團員離線與隨時放大檢視！</p>
        ${adminUploadBtn}
      </div>
    `;
  }

  const mapHtml = `
    <div class="route-map-card">
      ${mapContentHtml}
    </div>
  `;

  // 2. 周遊券與費用總覽儀表板
  const passesHtml = passes
    .map((p, idx) => {
      const safePassName = escapeHtml(p.name);
      const safeCost = escapeHtml(p.cost);
      const safeCurr = escapeHtml(p.currency || "日円");
      const safeNote = escapeHtml(p.note || "");
      const adminPassActions = isAdmin
        ? `<button class="btn-mini btn-mini-danger" style="margin-left:6px;padding:1px 6px;" onclick="deleteTransitPass(${idx})">✕</button>`
        : "";

      return `
      <div style="background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.35);padding:6px 12px;border-radius:12px;display:inline-flex;align-items:center;margin-top:6px;margin-right:6px;">
        <span style="font-weight:800;font-size:12px;">🎟️ ${safePassName}</span>
        ${safeCost ? `<span style="font-size:11px;margin-left:6px;opacity:0.9;">(${safeCost} ${safeCurr})</span>` : ""}
        ${safeNote ? `<span style="font-size:10px;margin-left:4px;opacity:0.8;">· ${safeNote}</span>` : ""}
        ${adminPassActions}
      </div>
    `;
    })
    .join("");

  const budgetDashboardHtml = `
    <div class="card" style="background:var(--moss-gradient);color:#FFF;border:none;box-shadow:0 14px 36px rgba(31,54,36,0.25);margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;">
        <div>
          <div style="font-size:11px;color:rgba(255,255,255,0.8);letter-spacing:1.5px;font-weight:800;">TRANSIT & PASSES</div>
          <div style="font-family:'Noto Serif TC',serif;font-size:19px;font-weight:900;margin-top:2px;">
            💰 預估交通總花費/人：${totalCostYen ? `¥${totalCostYen.toLocaleString()}` : ""}${totalCostYen && totalCostNtd ? " ＋ " : ""}${totalCostNtd ? `NT$${totalCostNtd.toLocaleString()}` : ""}${!totalCostYen && !totalCostNtd ? "¥0" : ""}
          </div>
        </div>
        ${isAdmin ? `<button class="btn-mini" style="background:rgba(255,255,255,0.25);color:#fff;" onclick="openAddTransitPassModal()">＋ 新增周遊券</button>` : ""}
      </div>
      ${passes.length ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;">${passesHtml}</div>` : ""}
    </div>
  `;

  // 3. 依天數分組的乘車時間軸
  const groupedRoutes = {};
  routes.forEach((r, idx) => {
    const tag = r.dayTag || "主要交通";
    if (!groupedRoutes[tag]) groupedRoutes[tag] = [];
    groupedRoutes[tag].push({ ...r, originalIdx: idx });
  });

  const groupKeys = Object.keys(groupedRoutes).sort((a, b) => {
    const matchA = a.match(/D(\d+)/i);
    const matchB = b.match(/D(\d+)/i);
    if (matchA && matchB) {
      return parseInt(matchA[1], 10) - parseInt(matchB[1], 10);
    }
    if (matchA) return -1;
    if (matchB) return 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
  const transitListHtml = groupKeys.length
    ? groupKeys
      .map((tag) => {
        const itemsHtml = groupedRoutes[tag]
          .map((item) => {
            const safeFromTo = escapeHtml(item.fromTo || "未命名路線");
            const safeTime = escapeHtml(item.time || "");
            const safeTrain = escapeHtml(item.trainInfo || "");
            const safeSeat = escapeHtml(item.seatInfo || "");
            const safeCost = escapeHtml(item.cost || "");
            const safeCurr = escapeHtml(item.currency || "日円");
            const safeNote = escapeHtml(item.note || "");
            const origIdx = item.originalIdx;

            const adminActions = isAdmin
              ? `
              <div class="item-actions">
                <button class="btn-mini" onclick="openEditTransportModal(${origIdx})">✏️ 修改</button>
                <button class="btn-mini btn-mini-danger" onclick="deleteTransportItem(${origIdx})">🗑️ 刪除</button>
              </div>
            `
              : "";

            return `
              <div class="transit-item-card">
                <div class="transit-header-row">
                  <div class="transit-route-title">
                    <span>🚆</span>
                    <span>${safeFromTo}</span>
                  </div>
                  <div style="display:flex;align-items:center;gap:6px;">
                    ${safeTime ? `<span class="transit-time-tag">🕒 ${safeTime}</span>` : ""}
                    ${adminActions}
                  </div>
                </div>
                <div class="transit-tags-row">
                  ${safeTrain ? `<span class="transit-badge-train">🏷️ ${safeTrain}</span>` : ""}
                  ${safeSeat ? `<span class="transit-badge-seat">💺 ${safeSeat}</span>` : ""}
                  ${safeCost ? `<span class="transit-badge-cost">💵 ${safeCost} ${safeCurr}</span>` : ""}
                </div>
                ${safeNote ? `<div style="font-size:12px;color:#666;margin-top:8px;line-height:1.5;background:#FAF8F5;padding:6px 10px;border-radius:8px;border:1px dashed var(--mist);">📝 ${safeNote}</div>` : ""}
              </div>
            `;
          })
          .join("");

        return `
          <div class="transit-day-group">
            <div class="transit-day-header">
              <span class="transit-day-badge">${tag}</span>
            </div>
            ${itemsHtml}
          </div>
        `;
      })
      .join("")
    : `<div class="card" style="text-align:center;padding:36px 16px;"><p style="color:#888;font-size:13px;">目前尚未新增每日乘車行程</p></div>`;

  const addRouteBtn = isAdmin
    ? `
    <button class="glass-btn" style="background:var(--moss-gradient);color:#fff;width:100%;margin-top:16px;justify-content:center;" onclick="openAddTransportModal()">＋ 新增乘車行程</button>
  `
    : "";

  document.getElementById("page-transport").innerHTML = `
    ${mapHtml}
    ${budgetDashboardHtml}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <h3 style="font-size:16px;font-weight:900;color:var(--moss);margin:0;">🚆 每日乘車行程</h3>
    </div>
    ${transitListHtml}
    ${addRouteBtn}
  `;
}

// 路線圖燈箱開啟與關閉 (支援相簿索引切換與相容直接網址)
function openMapLightbox(idxOrUrl, caption = "") {
  ensureTransportData();
  const overlay = document.getElementById("imageLightbox");
  const img = document.getElementById("lightboxImg");
  const titleEl = document.getElementById("lightboxTitle");
  const capEl = document.getElementById("lightboxCaption");
  const prevBtn = document.getElementById("lightboxPrevBtn");
  const nextBtn = document.getElementById("lightboxNextBtn");

  if (!overlay || !img) return;

  const maps = (tripData && tripData.transport && tripData.transport.maps) || [];

  if (typeof idxOrUrl === "number") {
    currentLightboxMapIdx = idxOrUrl;
    if (currentLightboxMapIdx < 0) currentLightboxMapIdx = 0;
    if (currentLightboxMapIdx >= maps.length) currentLightboxMapIdx = maps.length - 1;

    const currentMap = maps[currentLightboxMapIdx];
    if (currentMap) {
      img.src = sanitizeUrl(currentMap.url);
      if (titleEl) titleEl.innerText = `🗺️ ${currentMap.title || "交通路線圖"}`;
      if (capEl) {
        capEl.innerText = `${currentMap.note ? currentMap.note + " · " : ""}(${currentLightboxMapIdx + 1} / ${maps.length}) · 點擊任意處或按 ESC 關閉`;
      }
    }
  } else {
    // 傳入純圖片網址的相容模式
    img.src = sanitizeUrl(idxOrUrl);
    if (titleEl) titleEl.innerText = "🗺️ 交通路線圖";
    if (capEl) capEl.innerText = caption || "點擊任意處或按 ESC 關閉";
  }

  // 若有多張地圖則顯示左右導航按鈕
  const showNav = maps.length > 1 && typeof idxOrUrl === "number";
  if (prevBtn) prevBtn.style.display = showNav ? "flex" : "none";
  if (nextBtn) nextBtn.style.display = showNav ? "flex" : "none";

  overlay.style.display = "flex";
}

function prevLightboxMap(e) {
  if (e) e.stopPropagation();
  const maps = (tripData && tripData.transport && tripData.transport.maps) || [];
  if (maps.length <= 1) return;
  currentLightboxMapIdx = (currentLightboxMapIdx - 1 + maps.length) % maps.length;
  openMapLightbox(currentLightboxMapIdx);
}

function nextLightboxMap(e) {
  if (e) e.stopPropagation();
  const maps = (tripData && tripData.transport && tripData.transport.maps) || [];
  if (maps.length <= 1) return;
  currentLightboxMapIdx = (currentLightboxMapIdx + 1) % maps.length;
  openMapLightbox(currentLightboxMapIdx);
}

function closeMapLightbox() {
  const overlay = document.getElementById("imageLightbox");
  if (overlay) overlay.style.display = "none";
}

// 全域鍵盤監聽 (按 ESC 鍵關閉燈箱與彈窗，按左右鍵切換燈箱地圖)
window.addEventListener("keydown", function (e) {
  const lightbox = document.getElementById("imageLightbox");
  const isLightboxOpen = lightbox && lightbox.style.display !== "none";

  if (e.key === "Escape" || e.keyCode === 27) {
    closeMapLightbox();
    closeModal();
    closeGoogleLoginModal();
  } else if (isLightboxOpen) {
    if (e.key === "ArrowLeft" || e.keyCode === 37) {
      prevLightboxMap();
    } else if (e.key === "ArrowRight" || e.keyCode === 39) {
      nextLightboxMap();
    }
  }
});

// 新增交通路線圖對話框
function openAddRouteMapModal() {
  ensureTransportData();
  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">路線圖名稱 / 系統分類 <span style="color:var(--red);">*</span></div>
      <input type="text" id="addMapTitle" class="ef-input" placeholder="例如: 名古屋市營地下鐵全圖、JR 東海路線圖">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">上傳高清路線地圖照片 (支援自動壓縮) <span style="color:var(--red);">*</span></div>
      <input type="file" accept="image/*" id="addMapFile" onchange="uploadImageInModal(this, 'addMapImgUrl', 'addMapPreviewDiv')">
      <input type="hidden" id="addMapImgUrl" value="">
    </div>
    <div id="addMapPreviewDiv" style="margin-top:8px;"></div>
    <div class="ef-wrap" style="margin-top:12px;">
      <div class="ef-label">備註說明 / 適用區間</div>
      <textarea id="addMapNote" class="ef-textarea" placeholder="例如: 包含名城線、東山線；適用昇龍道地下鐵 24 小時券"></textarea>
    </div>
  `;

  openFormModal({
    title: "🗺️ 新增交通路線圖",
    bodyHtml: formHtml,
    confirmText: "確認新增並同步",
    onConfirm: () => {
      const title = document.getElementById("addMapTitle").value.trim();
      const imgUrl = document.getElementById("addMapImgUrl").value.trim();
      const note = document.getElementById("addMapNote").value.trim();

      if (!title) {
        alert("請輸入路線圖名稱！");
        return false;
      }
      if (!imgUrl) {
        alert("請上傳路線地圖照片！");
        return false;
      }

      tripData.transport.maps.push({
        id: uid(),
        title: title,
        url: imgUrl,
        note: note,
      });

      // 同步設定主要地圖向後相容欄位
      tripData.transport.mapImgUrl = tripData.transport.maps[0].url;
      tripData.transport.mapNote = tripData.transport.maps[0].title;

      renderTransport();
      save();
      return true;
    },
  });
}

// 編輯指定交通路線圖對話框
function openEditRouteMapModal(idx) {
  ensureTransportData();
  const map = tripData.transport.maps[idx];
  if (!map) return;

  const currentTitle = map.title || "";
  const currentImg = map.url || "";
  const currentNote = map.note || "";

  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">路線圖名稱 / 系統分類 <span style="color:var(--red);">*</span></div>
      <input type="text" id="editMapTitle" class="ef-input" placeholder="例如: 名古屋市營地下鐵全圖" value="${escapeHtml(currentTitle)}">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">更換高清路線地圖照片 (若不更換請留空)</div>
      <input type="file" accept="image/*" id="editMapFile" onchange="uploadImageInModal(this, 'editMapImgUrl', 'editMapPreviewDiv')">
      <input type="hidden" id="editMapImgUrl" value="${currentImg}">
    </div>
    <div id="editMapPreviewDiv" style="margin-top:8px;">
      ${currentImg ? `<img src="${currentImg}" style="max-height:140px;border-radius:10px;border:1px solid #DDD;" onerror="handleImgError(this)">` : ""}
    </div>
    <div class="ef-wrap" style="margin-top:12px;">
      <div class="ef-label">備註說明 / 適用區間</div>
      <textarea id="editMapNote" class="ef-textarea" placeholder="例如: 包含名城線、東山線">${escapeHtml(currentNote)}</textarea>
    </div>
  `;

  openFormModal({
    title: `✏️ 修改路線圖 - ${escapeHtml(currentTitle || "地圖")}`,
    bodyHtml: formHtml,
    confirmText: "儲存修改並同步",
    onConfirm: () => {
      const title = document.getElementById("editMapTitle").value.trim();
      const imgUrl = document.getElementById("editMapImgUrl").value.trim();
      const note = document.getElementById("editMapNote").value.trim();

      if (!title) {
        alert("請輸入路線圖名稱！");
        return false;
      }
      if (!imgUrl) {
        alert("路線地圖照片不能為空！");
        return false;
      }

      map.title = title;
      map.url = imgUrl;
      map.note = note;

      // 更新首張地圖向下相容欄位
      if (idx === 0) {
        tripData.transport.mapImgUrl = imgUrl;
        tripData.transport.mapNote = title;
      }

      renderTransport();
      save();
      return true;
    },
  });
}

// 刪除指定路線圖
function deleteRouteMap(idx) {
  ensureTransportData();
  const map = tripData.transport.maps[idx];
  if (!map) return;

  openConfirmModal({
    title: "刪除路線圖確認",
    message: `確定要刪除「${map.title || "此路線圖"}」嗎？`,
    danger: true,
    confirmText: "確定刪除",
    onConfirm: () => {
      tripData.transport.maps.splice(idx, 1);
      if (tripData.transport.maps.length > 0) {
        tripData.transport.mapImgUrl = tripData.transport.maps[0].url;
        tripData.transport.mapNote = tripData.transport.maps[0].title;
      } else {
        tripData.transport.mapImgUrl = "";
        tripData.transport.mapNote = "";
      }
      renderTransport();
      save();
    },
  });
}

// 向下相容舊版按鈕呼叫 (一律導向新增路線圖，避免不小心覆蓋現有地圖)
function openUploadRouteMapModal() {
  openAddRouteMapModal();
}

// 新增乘車行程對話框
function openAddTransportModal() {
  if (!tripData.transport) {
    tripData.transport = { mapImgUrl: "", mapNote: "", passes: [], routes: [] };
  }
  if (!tripData.transport.routes) tripData.transport.routes = [];

  // 推算天數標籤候選清單 (如 D1-2/12, D2-2/13)
  const dayOptions = (tripData.days || []).map((d, i) => {
    const m = (d.id || "").match(/Day\s*(\d+)/i);
    const dayPrefix = m ? `D${m[1]}` : `D${i + 1}`;
    const rawDate = (d.date || "").split("（")[0].replace("月", "/").replace("日", "").trim();
    const tag = `${dayPrefix}${rawDate ? `-${rawDate}` : ""}`;
    const label = `${tag}（${d.id}：${d.date || ""} ｜ ${d.title || "未設定主題"}）`;
    return { tag, label };
  });

  // 預設選中當前行程選中的天數或第 1 天
  const currentSelectedDayTag = dayOptions[selectedDay]
    ? dayOptions[selectedDay].tag
    : dayOptions[0]
      ? dayOptions[0].tag
      : "主要交通";

  // 全域回呼：點擊快捷標籤或切換下拉選單
  window.onSelectTransitDay = function (tag) {
    if (!tag) return;
    const input = document.getElementById("addTransDay");
    if (input) {
      if (tag === "__custom__") {
        input.value = "";
        input.focus();
      } else {
        input.value = tag;
      }
    }
  };

  const tagButtonsHtml = dayOptions.length
    ? `
      <div class="time-tags" style="margin-bottom:8px;">
        ${dayOptions
          .map(
            (opt) =>
              `<button type="button" class="time-tag" onclick="window.onSelectTransitDay('${opt.tag}')">${opt.tag}</button>`
          )
          .join("")}
        <button type="button" class="time-tag" onclick="window.onSelectTransitDay('主要交通')">主要交通</button>
      </div>
    `
    : "";

  const selectOptionsHtml = `
    ${dayOptions.map((opt) => `<option value="${opt.tag}" ${opt.tag === currentSelectedDayTag ? "selected" : ""}>${opt.label}</option>`).join("")}
    <option value="主要交通" ${currentSelectedDayTag === "主要交通" ? "selected" : ""}>主要交通 (全程通用 / 機場接駁)</option>
  `;

  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">選擇乘車所屬天數 <span style="color:var(--red);">*</span></div>
      <select id="addTransDay" class="ef-select">
        ${selectOptionsHtml}
      </select>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">乘車區間 / 路線 <span style="color:var(--red);">*</span></div>
      <input type="text" id="addTransFromTo" class="ef-input" placeholder="例如: 岡山機場～岡山站、岡山站到JR 琴平站">
    </div>
    <div style="display:flex;gap:10px;">
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">發車/抵達時間</div>
        <input type="text" id="addTransTime" class="ef-input" placeholder="例如: 14:30 或 下午 4:03">
      </div>
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">預估費用 / 人</div>
        <input type="text" id="addTransCost" class="ef-input" placeholder="例如: 1000 或 0">
      </div>
    </div>
    <div style="display:flex;gap:10px;">
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">車種名稱 (例如: JR特急、機場巴士)</div>
        <input type="text" id="addTransTrain" class="ef-input" placeholder="例如: 機場巴士、JR 瀨戶大橋線">
      </div>
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">劃位/座位資訊</div>
        <input type="text" id="addTransSeat" class="ef-input" placeholder="例如: 自由席、指定席、bus 2號口">
      </div>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">備註事項 (月台、轉乘、換券說明)</div>
      <textarea id="addTransNote" class="ef-textarea" placeholder="例如: bus 2號口搭乘、琴平站轉搭琴電"></textarea>
    </div>
  `;

  openFormModal({
    title: "➕ 新增乘車行程",
    bodyHtml: formHtml,
    confirmText: "確認新增並同步",
    onConfirm: () => {
      const dayTag = document.getElementById("addTransDay").value.trim();
      const fromTo = document.getElementById("addTransFromTo").value.trim();
      const time = document.getElementById("addTransTime").value.trim();
      const cost = document.getElementById("addTransCost").value.trim();
      const train = document.getElementById("addTransTrain").value.trim();
      const seat = document.getElementById("addTransSeat").value.trim();
      const note = document.getElementById("addTransNote").value.trim();

      if (!fromTo) {
        alert("請輸入乘車區間！");
        return false;
      }

      tripData.transport.routes.push({
        id: uid(),
        dayTag: dayTag || "主要交通",
        fromTo: fromTo,
        time: time,
        cost: cost,
        currency: "日円",
        trainInfo: train,
        seatInfo: seat,
        note: note,
      });

      renderTransport();
      save();
      return true;
    },
  });
}

// 編輯乘車行程對話框
function openEditTransportModal(idx) {
  const item = tripData.transport.routes[idx];
  if (!item) return;

  const dayOptions = (tripData.days || []).map((d, i) => {
    const m = (d.id || "").match(/Day\s*(\d+)/i);
    const dayPrefix = m ? `D${m[1]}` : `D${i + 1}`;
    const rawDate = (d.date || "").split("（")[0].replace("月", "/").replace("日", "").trim();
    const tag = `${dayPrefix}${rawDate ? `-${rawDate}` : ""}`;
    const label = `${tag}（${d.id}：${d.date || ""} ｜ ${d.title || "未設定主題"}）`;
    return { tag, label };
  });

  const selectOptionsHtml = `
    ${dayOptions.map((opt) => `<option value="${opt.tag}" ${opt.tag === item.dayTag ? "selected" : ""}>${opt.label}</option>`).join("")}
    <option value="主要交通" ${item.dayTag === "主要交通" ? "selected" : ""}>主要交通 (全程通用 / 機場接駁)</option>
  `;

  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">選擇乘車所屬天數 <span style="color:var(--red);">*</span></div>
      <select id="editTransDay" class="ef-select">
        ${selectOptionsHtml}
      </select>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">乘車區間 / 路線 <span style="color:var(--red);">*</span></div>
      <input type="text" id="editTransFromTo" class="ef-input" value="${item.fromTo || ""}">
    </div>
    <div style="display:flex;gap:10px;">
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">發車/抵達時間</div>
        <input type="text" id="editTransTime" class="ef-input" value="${item.time || ""}">
      </div>
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">預估費用 / 人</div>
        <input type="text" id="editTransCost" class="ef-input" value="${item.cost || ""}">
      </div>
    </div>
    <div style="display:flex;gap:10px;">
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">車種名稱</div>
        <input type="text" id="editTransTrain" class="ef-input" value="${item.trainInfo || ""}">
      </div>
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">劃位/座位資訊</div>
        <input type="text" id="editTransSeat" class="ef-input" value="${item.seatInfo || ""}">
      </div>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">備註事項</div>
      <textarea id="editTransNote" class="ef-textarea">${item.note || ""}</textarea>
    </div>
  `;

  openFormModal({
    title: "✏️ 編輯乘車行程",
    bodyHtml: formHtml,
    confirmText: "儲存修改並同步",
    onConfirm: () => {
      const dayTag = document.getElementById("editTransDay").value.trim();
      const fromTo = document.getElementById("editTransFromTo").value.trim();
      const time = document.getElementById("editTransTime").value.trim();
      const cost = document.getElementById("editTransCost").value.trim();
      const train = document.getElementById("editTransTrain").value.trim();
      const seat = document.getElementById("editTransSeat").value.trim();
      const note = document.getElementById("editTransNote").value.trim();

      if (!fromTo) {
        alert("請輸入乘車區間！");
        return false;
      }

      tripData.transport.routes[idx] = {
        ...item,
        dayTag: dayTag || "主要交通",
        fromTo: fromTo,
        time: time,
        cost: cost,
        trainInfo: train,
        seatInfo: seat,
        note: note,
      };

      renderTransport();
      save();
      return true;
    },
  });
}

// 刪除乘車行程
function deleteTransportItem(idx) {
  const item = tripData.transport.routes[idx];
  openConfirmModal({
    title: "刪除乘車行程確認",
    message: `確定要刪除「${item.fromTo || "此乘車段"}」嗎？`,
    danger: true,
    confirmText: "確定刪除",
    onConfirm: () => {
      tripData.transport.routes.splice(idx, 1);
      renderTransport();
      save();
    },
  });
}

// 新增周遊券對話框
function openAddTransitPassModal() {
  if (!tripData.transport) {
    tripData.transport = { mapImgUrl: "", mapNote: "", passes: [], routes: [] };
  }
  if (!tripData.transport.passes) tripData.transport.passes = [];

  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">周遊券 / 交通票券名稱 <span style="color:var(--red);">*</span></div>
      <input type="text" id="addPassName" class="ef-input" placeholder="例如: 黑部立山周遊券、JR 全國 Pass">
    </div>
    <div style="display:flex;gap:10px;">
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">票券費用 (純數字)</div>
        <input type="text" id="addPassCost" class="ef-input" placeholder="例如: 24000">
      </div>
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">幣別</div>
        <input type="text" id="addPassCurr" class="ef-input" value="日円">
      </div>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">備註說明 (購買管道、兌換窗口)</div>
      <textarea id="addPassNote" class="ef-textarea" placeholder="例如: 於中部國際機場名鐵窗口/名古屋站綠色窗口兌換"></textarea>
    </div>
  `;

  openFormModal({
    title: "🎟️ 新增周遊券 / 交通票券",
    bodyHtml: formHtml,
    confirmText: "確認新增並同步",
    onConfirm: () => {
      const name = document.getElementById("addPassName").value.trim();
      const cost = document.getElementById("addPassCost").value.trim();
      const curr = document.getElementById("addPassCurr").value.trim() || "日円";
      const note = document.getElementById("addPassNote").value.trim();

      if (!name) {
        alert("請輸入票券名稱！");
        return false;
      }

      tripData.transport.passes.push({
        id: uid(),
        name: name,
        cost: cost,
        currency: curr,
        note: note,
      });

      renderTransport();
      save();
      return true;
    },
  });
}

function deleteTransitPass(idx) {
  const pass = tripData.transport.passes[idx];
  openConfirmModal({
    title: "刪除周遊券確認",
    message: `確定要刪除「${pass.name}」嗎？`,
    danger: true,
    confirmText: "確定刪除",
    onConfirm: () => {
      tripData.transport.passes.splice(idx, 1);
      renderTransport();
      save();
    },
  });
}

// =========================================================================
// 主渲染分流
// =========================================================================
function render() {
  if (currentTab === "checklist") renderChecklist();
  else if (currentTab === "flights") renderFlights();
  else if (currentTab === "transport") renderTransport();
  else if (currentTab === "itinerary") renderItinerary();
  else if (currentTab === "food") renderFood();
  else if (currentTab === "shopping") renderShopping();
  else if (currentTab === "admin") renderAdmin();
}
