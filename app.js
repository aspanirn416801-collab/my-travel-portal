// =========================================================================
// 公版設定：請填入您的 Google Client ID 與 GAS API URL
// =========================================================================
const GOOGLE_CLIENT_ID = "1097668023463-ibj8qn5c98mhviggncl5a9m3t7dmjc45.apps.googleusercontent.com";
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbzYvXwpdMDo5kn2TDlvSgbD2s-rXIqPMl6jn66jdWju239vRDqLoq2jcNmcD9vPNKvihA/exec";

// 前端全局狀態管理 (啟動時立即從 LocalStorage 快取中還原，實現 0.001 秒瞬間秒開！)
let idToken = localStorage.getItem("google_id_token") || null;
let userRole = localStorage.getItem("cache_userRole") || "guest"; // 'admin' | 'user' | 'guest'

// 安全校驗：若無有效 Token 或已逾期，一律強制歸為 guest 訪客身分，防止身分快取偽冒
if (!idToken || isTokenExpired(idToken)) {
  userRole = "guest";
  try {
    localStorage.setItem("cache_userRole", "guest");
  } catch (e) {}
}

let tripsList = []; // 可存取的行程列表
let currentTripUuid = "";
let tripData = null; // 當前行程詳細手冊資料
let currentTab = "checklist";
let selectedDay = 0;
let currentFoodFilter = "all"; // 美食分類過濾：'all' | 'must' | 'todo' | 'done' | 地區名稱
let currentShoppingFilter = "all"; // 代購分類過濾：'all' | 'todo' | 'done' | 委託人姓名

// 升級快取清理：強制清除舊版無密碼標記的舊快取，防止舊快取未上鎖漏洞
try {
  const cacheVersion = localStorage.getItem("app_cache_version");
  if (cacheVersion !== "20260906_lock_v3") {
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith("cache_trip_") || key === "cache_tripsList" || key.startsWith("unlocked_trip_")) {
        localStorage.removeItem(key);
      }
    });
    localStorage.setItem("app_cache_version", "20260906_lock_v3");
  }
} catch (e) {}

// 預先同步載入本地快取
try {
  const cachedTrips = localStorage.getItem("cache_tripsList");
  if (cachedTrips) tripsList = JSON.parse(cachedTrips);
} catch (e) {}

// =========================================================================
// 旅程專屬密碼鎖機制 (管理員尊榮免密碼直通、訪客/團員密碼唯讀、Session 隔離關閉即鎖定)
// =========================================================================
// 清除舊版本殘留在 localStorage 中的解鎖標記，確保「關閉網頁/離開即鎖定」嚴格生效
try {
  Object.keys(localStorage).forEach((key) => {
    if (key.startsWith("unlocked_trip_")) {
      localStorage.removeItem(key);
    }
  });
} catch (e) {}

// =========================================================================
// 專案主題色彩管理系統 (因應四季時令與旅行目的地之高階奢華色彩引擎)
// =========================================================================
const TRIP_THEMES = {
  winter: {
    id: "winter",
    name: "❄️ 冬季 • 霜雪冰晶藍 (12~2月冬季旅程)",
    vars: {
      "--moss": "#1E3A5F",
      "--moss-light": "#2E5688",
      "--moss-gradient": "linear-gradient(135deg, #183153 0%, #2E5888 100%)",
      "--washi": "#F4F7FB",
      "--bg-gradient": "linear-gradient(135deg, #F5F8FB 0%, #E9F0F7 50%, #F8FAFC 100%)",
      "--gold": "#3B82F6",
      "--gold-soft": "rgba(59, 130, 246, 0.16)",
      "--mist": "#CFDAE6",
    },
  },
  spring: {
    id: "spring",
    name: "🌸 春季 • 霞櫻緋粉 (3~5月賞櫻春旅)",
    vars: {
      "--moss": "#82354F",
      "--moss-light": "#9E4765",
      "--moss-gradient": "linear-gradient(135deg, #742D43 0%, #A24B68 100%)",
      "--washi": "#FBF6F8",
      "--bg-gradient": "linear-gradient(135deg, #FAF4F6 0%, #F4E8EC 50%, #FCF8FA 100%)",
      "--gold": "#D9779F",
      "--gold-soft": "rgba(217, 119, 159, 0.16)",
      "--mist": "#EAD3DC",
    },
  },
  summer: {
    id: "summer",
    name: "🌊 夏季 • 碧海琉璃 (6~8月海島夏日)",
    vars: {
      "--moss": "#0E4F5D",
      "--moss-light": "#186E80",
      "--moss-gradient": "linear-gradient(135deg, #0A3E4A 0%, #19788D 100%)",
      "--washi": "#F2F8F9",
      "--bg-gradient": "linear-gradient(135deg, #F1F7F8 0%, #E3EFF2 50%, #F7FAFA 100%)",
      "--gold": "#2596BE",
      "--gold-soft": "rgba(37, 150, 190, 0.16)",
      "--mist": "#C7DFE5",
    },
  },
  autumn: {
    id: "autumn",
    name: "🍁 秋季 • 丹楓琥珀 (9~11月賞楓金秋)",
    vars: {
      "--moss": "#763B20",
      "--moss-light": "#954E2E",
      "--moss-gradient": "linear-gradient(135deg, #683017 0%, #9C512F 100%)",
      "--washi": "#FAF4F0",
      "--bg-gradient": "linear-gradient(135deg, #F9F3EE 0%, #F1E6DC 50%, #FAF5F1 100%)",
      "--gold": "#C2713F",
      "--gold-soft": "rgba(194, 113, 63, 0.18)",
      "--mist": "#E5D3C7",
    },
  },
  classic: {
    id: "classic",
    name: "🌿 經典 • 常磐和風 (日系文青苔綠)",
    vars: {
      "--moss": "#1A3822",
      "--moss-light": "#2D5A37",
      "--moss-gradient": "linear-gradient(135deg, #1A3822 0%, #2D5A37 100%)",
      "--washi": "#F6F3EE",
      "--bg-gradient": "linear-gradient(135deg, #F5F1EB 0%, #EAE4D9 50%, #FAF7F3 100%)",
      "--gold": "#C5A059",
      "--gold-soft": "rgba(197, 160, 89, 0.2)",
      "--mist": "#D5CFC5",
    },
  },
  lavender: {
    id: "lavender",
    name: "🪻 特色 • 輕奢薰衣草 (高雅霧灰紫)",
    vars: {
      "--moss": "#4B406B",
      "--moss-light": "#65578E",
      "--moss-gradient": "linear-gradient(135deg, #3F345E 0%, #6B5D96 100%)",
      "--washi": "#F6F4FA",
      "--bg-gradient": "linear-gradient(135deg, #F6F4FA 0%, #EBE7F4 50%, #F9F8FC 100%)",
      "--gold": "#8371B2",
      "--gold-soft": "rgba(131, 113, 178, 0.16)",
      "--mist": "#D8D2E6",
    },
  },
};

// 舊版與別名相容映射
TRIP_THEMES.violet = TRIP_THEMES.winter; // 經典冬日自動升級為純淨雪晶藍
TRIP_THEMES.moss = TRIP_THEMES.classic;
TRIP_THEMES.ocean = TRIP_THEMES.summer;
TRIP_THEMES.sunset = TRIP_THEMES.autumn;
TRIP_THEMES.sakura = TRIP_THEMES.spring;
TRIP_THEMES.amber = TRIP_THEMES.autumn;
TRIP_THEMES.midnight = TRIP_THEMES.winter;

// 依出發季節與月份自然智能適配四季色彩
function getAutoThemeKeyForTrip(tripName = "", tripUuid = "", startDate = "") {
  let dateStr = startDate;
  if (!dateStr && tripData && tripData.startDate) {
    dateStr = tripData.startDate;
  }
  if (!dateStr) {
    // 從 uuid 或行程名稱嘗試萃取月份 (例如 2027-02okayama -> 02 月 -> 冬季)
    const mMatch = (String(tripUuid) + " " + String(tripName)).match(/(?:20\d{2}[-_/])?0?(\d{1,2})[-_/]?/);
    if (mMatch && mMatch[1]) {
      const m = parseInt(mMatch[1], 10);
      if (m >= 3 && m <= 5) return "spring";
      if (m >= 6 && m <= 8) return "summer";
      if (m >= 9 && m <= 11) return "autumn";
      if (m === 12 || m === 1 || m === 2) return "winter";
    }
  }

  if (dateStr) {
    const match = String(dateStr).match(/-0?(\d{1,2})-/);
    if (match) {
      const month = parseInt(match[1], 10);
      if (month >= 3 && month <= 5) return "spring";
      if (month >= 6 && month <= 8) return "summer";
      if (month >= 9 && month <= 11) return "autumn";
      return "winter";
    }
  }

  // 關鍵字檢測
  const combined = (String(tripName) + " " + String(tripUuid)).toLowerCase();
  if (combined.includes("櫻") || combined.includes("sakura") || combined.includes("春")) return "spring";
  if (combined.includes("海") || combined.includes("沖繩") || combined.includes("夏")) return "summer";
  if (combined.includes("楓") || combined.includes("秋") || combined.includes("銀杏")) return "autumn";
  if (combined.includes("雪") || combined.includes("冬") || combined.includes("滑雪")) return "winter";
  if (combined.includes("薰衣草") || combined.includes("lavender")) return "lavender";

  return "classic";
}

// 套用主題色彩至全域 CSS 變數
function applyTripTheme(themeKey, tripName = "", tripUuid = "", startDate = "") {
  let key = themeKey;
  if (!key || !TRIP_THEMES[key]) {
    key = getAutoThemeKeyForTrip(tripName, tripUuid, startDate);
  }
  const theme = TRIP_THEMES[key] || TRIP_THEMES["winter"];
  const root = document.documentElement;
  Object.entries(theme.vars).forEach(([prop, val]) => {
    root.style.setProperty(prop, val);
  });
}

function resetToDefaultTheme() {
  applyTripTheme("classic");
}

// 全域通用旅程天數與晚數自動計算函式 (支援任何標準 ISO 日期或日期格式，徹底杜絕未註記天數！)
function calculateTripDuration(startDate, endDate) {
  if (!startDate || !endDate) return "";
  try {
    const sStr = String(startDate).split("T")[0].trim();
    const eStr = String(endDate).split("T")[0].trim();
    if (!sStr || !eStr) return "";
    const d1 = new Date(sStr + "T00:00:00");
    const d2 = new Date(eStr + "T00:00:00");
    if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return "";
    const diffTime = d2.getTime() - d1.getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24)) + 1;
    if (diffDays > 0) {
      const nights = diffDays - 1;
      return `${diffDays}天${nights > 0 ? nights + "夜" : ""}`;
    }
  } catch (e) {}
  return "";
}

// =========================================================================
// 旅程天氣預報模組 (整合 Open-Meteo 免費 API，支援全球各大洲熱門城市與動態切換)
// =========================================================================
const WEATHER_CITY_PRESETS = [
  // 歐洲主要旅遊名城
  { id: "vienna", name: "奧地利 維也納 (Vienna)", lat: 48.2082, lon: 16.3738, tz: "Europe/Vienna" },
  { id: "prague", name: "捷克 布拉格 (Prague)", lat: 50.0755, lon: 14.4378, tz: "Europe/Prague" },
  { id: "salzburg", name: "奧地利 薩爾斯堡 (Salzburg)", lat: 47.8095, lon: 13.055, tz: "Europe/Vienna" },
  { id: "hallstatt", name: "奧地利 哈修塔特 (Hallstatt)", lat: 47.5622, lon: 13.6493, tz: "Europe/Vienna" },
  { id: "cesky_krumlov", name: "捷克 庫倫洛夫 (Český Krumlov)", lat: 48.8127, lon: 14.3175, tz: "Europe/Prague" },
  { id: "innsbruck", name: "奧地利 因斯布魯克 (Innsbruck)", lat: 47.2692, lon: 11.4041, tz: "Europe/Vienna" },
  { id: "budapest", name: "匈牙利 布達佩斯 (Budapest)", lat: 47.4979, lon: 19.0402, tz: "Europe/Budapest" },
  { id: "paris", name: "法國 巴黎 (Paris)", lat: 48.8566, lon: 2.3522, tz: "Europe/Paris" },
  { id: "london", name: "英國 倫敦 (London)", lat: 51.5074, lon: -0.1278, tz: "Europe/London" },
  { id: "zurich", name: "瑞士 蘇黎世 (Zurich)", lat: 47.3769, lon: 8.5417, tz: "Europe/Zurich" },
  { id: "rome", name: "義大利 羅馬 (Rome)", lat: 41.9028, lon: 12.4964, tz: "Europe/Rome" },
  { id: "venice", name: "義大利 威尼斯 (Venice)", lat: 45.4408, lon: 12.3155, tz: "Europe/Rome" },
  { id: "munich", name: "德國 慕尼黑 (Munich)", lat: 48.1351, lon: 11.582, tz: "Europe/Berlin" },
  { id: "amsterdam", name: "荷蘭 阿姆斯特丹 (Amsterdam)", lat: 52.3676, lon: 4.9041, tz: "Europe/Amsterdam" },
  { id: "reykjavik", name: "冰島 雷克雅維克 (Reykjavik)", lat: 64.1466, lon: -21.9426, tz: "Atlantic/Reykjavik" },
  { id: "oslo", name: "挪威 奧斯陸 (Oslo)", lat: 59.9139, lon: 10.7522, tz: "Europe/Oslo" },
  // 大洋洲 & 美洲
  { id: "queenstown", name: "紐西蘭 皇后鎮 (Queenstown)", lat: -45.0312, lon: 168.6626, tz: "Pacific/Auckland" },
  { id: "auckland", name: "紐西蘭 奧克蘭 (Auckland)", lat: -36.8485, lon: 174.7633, tz: "Pacific/Auckland" },
  { id: "sydney", name: "澳洲 雪梨 (Sydney)", lat: -33.8688, lon: 151.2093, tz: "Australia/Sydney" },
  { id: "melbourne", name: "澳洲 墨爾本 (Melbourne)", lat: -37.8136, lon: 144.9631, tz: "Australia/Melbourne" },
  { id: "newyork", name: "美國 紐約 (New York)", lat: 40.7128, lon: -74.006, tz: "America/New_York" },
  { id: "losangeles", name: "美國 洛杉磯 (Los Angeles)", lat: 34.0522, lon: -118.2437, tz: "America/Los_Angeles" },
  { id: "honolulu", name: "美國 夏威夷檀香山 (Honolulu)", lat: 21.3069, lon: -157.8583, tz: "Pacific/Honolulu" },
  // 中東 & 非洲
  { id: "dubai", name: "阿聯 杜拜 (Dubai)", lat: 25.2048, lon: 55.2708, tz: "Asia/Dubai" },
  { id: "cairo", name: "埃及 開羅 (Cairo)", lat: 30.0444, lon: 31.2357, tz: "Africa/Cairo" },
  // 亞洲熱門國家與城市
  { id: "bangkok", name: "泰國 曼谷 (Bangkok)", lat: 13.7563, lon: 100.5018, tz: "Asia/Bangkok" },
  { id: "chiangmai", name: "泰國 清邁 (Chiang Mai)", lat: 18.7883, lon: 98.9853, tz: "Asia/Bangkok" },
  { id: "seoul", name: "韓國 首爾 (Seoul)", lat: 37.5665, lon: 126.978, tz: "Asia/Seoul" },
  { id: "busan", name: "韓國 釜山 (Busan)", lat: 35.1796, lon: 129.0756, tz: "Asia/Seoul" },
  { id: "singapore", name: "新加坡 (Singapore)", lat: 1.3521, lon: 103.8198, tz: "Asia/Singapore" },
  // 台灣代表城市
  { id: "taipei", name: "台灣 台北 (Taipei)", lat: 25.033, lon: 121.5654, tz: "Asia/Taipei" },
  { id: "kaohsiung", name: "台灣 高雄 (Kaohsiung)", lat: 22.6273, lon: 120.3014, tz: "Asia/Taipei" },
  // 日本代表城市
  { id: "tokyo", name: "日本 東京 (Tokyo)", lat: 35.6762, lon: 139.6503, tz: "Asia/Tokyo" },
  { id: "osaka", name: "日本 大阪 (Osaka)", lat: 34.6937, lon: 135.5023, tz: "Asia/Tokyo" },
  { id: "kyoto", name: "日本 京都 (Kyoto)", lat: 35.0116, lon: 135.7681, tz: "Asia/Tokyo" },
  { id: "fukuoka", name: "日本 福岡 (Fukuoka)", lat: 33.5904, lon: 130.4017, tz: "Asia/Tokyo" },
  { id: "sapporo", name: "日本 札幌 (Sapporo)", lat: 43.0618, lon: 141.3545, tz: "Asia/Tokyo" },
  { id: "okinawa", name: "日本 沖繩 (Naha)", lat: 26.2124, lon: 127.6809, tz: "Asia/Tokyo" },
  { id: "okayama", name: "日本 岡山 (Okayama)", lat: 34.6618, lon: 133.935, tz: "Asia/Tokyo" },
  { id: "kurashiki", name: "日本 倉敷 (Kurashiki)", lat: 34.5956, lon: 133.7719, tz: "Asia/Tokyo" },
];

let currentWeatherPeriod = "3day"; // '3day' | '7day'

function getWmoWeatherInfo(code) {
  if (code === 0) return { icon: "☀️", text: "晴朗無雲" };
  if (code === 1) return { icon: "🌤️", text: "晴時多雲" };
  if (code === 2) return { icon: "⛅", text: "多雲時晴" };
  if (code === 3) return { icon: "☁️", text: "陰天多雲" };
  if ([45, 48].includes(code)) return { icon: "🌫️", text: "晨間薄霧" };
  if ([51, 53, 55].includes(code)) return { icon: "🌦️", text: "毛毛細雨" };
  if ([61, 63, 65].includes(code)) return { icon: "🌧️", text: "陣雨綿綿" };
  if ([71, 73, 75, 77].includes(code)) return { icon: "❄️", text: "降雪紛飛" };
  if ([80, 81, 82].includes(code)) return { icon: "🌧️", text: "局部大雨" };
  if ([85, 86].includes(code)) return { icon: "🌨️", text: "飄雪陣雪" };
  if ([95, 96, 99].includes(code)) return { icon: "⛈️", text: "雷陣雨" };
  return { icon: "🌤️", text: "氣候舒適" };
}

// 智能檢測行程地點所屬之氣象城市 (全面支援歐洲奧捷、全球各大洲與日台，徹底拔除寫死岡山！)
function detectTripWeatherCity(trip, data) {
  const combined = [
    trip?.name || "",
    trip?.uuid || "",
    trip?.weatherCity || "",
    data?.name || "",
    data?.flights?.out?.to || "",
    data?.flights?.out?.note || "",
    ...(data?.hotels || []).map((h) => (h?.name || "") + " " + (h?.addr || "")),
    ...(data?.days || []).flatMap((d) => (d?.spots || []).map((s) => s?.place || "")),
  ].join(" ").toLowerCase();

  // 1. 奧地利 & 捷克城市優先匹配
  if (combined.includes("vienna") || combined.includes("維也納") || combined.includes("wien") || combined.includes("vie")) return "vienna";
  if (combined.includes("prague") || combined.includes("布拉格") || combined.includes("praha") || combined.includes("prg")) return "prague";
  if (combined.includes("salzburg") || combined.includes("薩爾斯堡")) return "salzburg";
  if (combined.includes("hallstatt") || combined.includes("哈修塔特")) return "hallstatt";
  if (combined.includes("krumlov") || combined.includes("庫倫洛夫") || combined.includes("ck小鎮")) return "cesky_krumlov";
  if (combined.includes("innsbruck") || combined.includes("因斯布魯克")) return "innsbruck";
  if (combined.includes("austria") || combined.includes("奧地利") || combined.includes("奧捷")) return "vienna";
  if (combined.includes("czech") || combined.includes("捷克")) return "prague";

  // 2. 歐洲其他名城 & 北歐 & 冰島
  if (combined.includes("iceland") || combined.includes("冰島") || combined.includes("reykjavik") || combined.includes("雷克雅維克")) return "reykjavik";
  if (combined.includes("norway") || combined.includes("挪威") || combined.includes("oslo") || combined.includes("奧斯陸")) return "oslo";
  if (combined.includes("budapest") || combined.includes("布達佩斯")) return "budapest";
  if (combined.includes("paris") || combined.includes("巴黎") || combined.includes("cdg")) return "paris";
  if (combined.includes("london") || combined.includes("倫敦") || combined.includes("lhr")) return "london";
  if (combined.includes("zurich") || combined.includes("蘇黎世") || combined.includes("瑞士") || combined.includes("swiss")) return "zurich";
  if (combined.includes("rome") || combined.includes("羅馬") || combined.includes("義大利") || combined.includes("italy")) return "rome";
  if (combined.includes("venice") || combined.includes("威尼斯")) return "venice";
  if (combined.includes("munich") || combined.includes("慕尼黑") || combined.includes("德國") || combined.includes("germany")) return "munich";
  if (combined.includes("amsterdam") || combined.includes("阿姆斯特丹") || combined.includes("荷蘭")) return "amsterdam";

  // 3. 大洋洲 & 美洲 & 中東非洲
  if (combined.includes("new zealand") || combined.includes("紐西蘭") || combined.includes("queenstown") || combined.includes("皇后鎮")) return "queenstown";
  if (combined.includes("auckland") || combined.includes("奧克蘭")) return "auckland";
  if (combined.includes("sydney") || combined.includes("雪梨") || combined.includes("澳洲") || combined.includes("australia")) return "sydney";
  if (combined.includes("melbourne") || combined.includes("墨爾本")) return "melbourne";
  if (combined.includes("new york") || combined.includes("紐約") || combined.includes("nyc")) return "newyork";
  if (combined.includes("los angeles") || combined.includes("洛杉磯") || combined.includes("la")) return "losangeles";
  if (combined.includes("hawaii") || combined.includes("夏威夷") || combined.includes("honolulu")) return "honolulu";
  if (combined.includes("dubai") || combined.includes("杜拜") || combined.includes("阿聯")) return "dubai";
  if (combined.includes("egypt") || combined.includes("埃及") || combined.includes("cairo") || combined.includes("開羅")) return "cairo";

  // 4. 亞洲熱門城市
  if (combined.includes("bangkok") || combined.includes("曼谷") || combined.includes("泰國") || combined.includes("thailand") || combined.includes("bkk")) return "bangkok";
  if (combined.includes("chiang mai") || combined.includes("清邁")) return "chiangmai";
  if (combined.includes("seoul") || combined.includes("首爾") || combined.includes("韓國") || combined.includes("korea") || combined.includes("icn")) return "seoul";
  if (combined.includes("busan") || combined.includes("釜山")) return "busan";
  if (combined.includes("singapore") || combined.includes("新加坡") || combined.includes("sin")) return "singapore";

  // 5. 日本主要城市
  if (combined.includes("kurashiki") || combined.includes("倉敷")) return "kurashiki";
  if (combined.includes("okayama") || combined.includes("岡山") || combined.includes("桃太郎") || combined.includes("okj")) return "okayama";
  if (combined.includes("tokyo") || combined.includes("東京") || combined.includes("hnd") || combined.includes("nrt")) return "tokyo";
  if (combined.includes("osaka") || combined.includes("大阪") || combined.includes("kix")) return "osaka";
  if (combined.includes("kyoto") || combined.includes("京都")) return "kyoto";
  if (combined.includes("fukuoka") || combined.includes("福岡") || combined.includes("九州") || combined.includes("fuk")) return "fukuoka";
  if (combined.includes("sapporo") || combined.includes("札幌") || combined.includes("北海道") || combined.includes("cts")) return "sapporo";
  if (combined.includes("okinawa") || combined.includes("沖繩") || combined.includes("那霸") || combined.includes("oka")) return "okinawa";

  // 6. 台灣城市
  if (combined.includes("taipei") || combined.includes("台北") || combined.includes("tpe") || combined.includes("tsa")) return "taipei";
  if (combined.includes("kaohsiung") || combined.includes("高雄") || combined.includes("khh")) return "kaohsiung";

  // 7. 大洲中性兜底 (絕不無腦退回岡山！)
  if (combined.includes("europe") || combined.includes("歐洲")) return "vienna";
  if (combined.includes("japan") || combined.includes("日本")) return "tokyo";
  if (combined.includes("america") || combined.includes("美洲")) return "newyork";

  return WEATHER_CITY_PRESETS[0].id;
}

// 支援動態全球城市解析與氣象取得
async function fetchWeatherForCity(cityOrId, forceRefresh = false) {
  let city = null;
  if (typeof cityOrId === "object" && cityOrId && cityOrId.lat && cityOrId.lon) {
    city = cityOrId;
  } else {
    city = WEATHER_CITY_PRESETS.find((c) => c.id === cityOrId) || WEATHER_CITY_PRESETS[0];
  }

  const cacheKey = `weather_cache_${city.id || (city.lat + "_" + city.lon)}`;

  if (!forceRefresh) {
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const { timestamp, data } = JSON.parse(cached);
        // 1 小時快取
        if (Date.now() - timestamp < 3600000) {
          return data;
        }
      }
    } catch (e) {}
  }

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=${encodeURIComponent(city.tz || "UTC")}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("天氣資料伺服器暫時無法連線");
  const data = await resp.json();
  try {
    localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data }));
  } catch (e) {}
  return data;
}

// 彈出更換/搜尋氣象城市對話框 (支援全域任何世界名城即時切換)
function openCustomWeatherCityModal() {
  const trip = tripsList.find((t) => t.uuid === currentTripUuid) || tripData;
  const currentCityId = localStorage.getItem("trip_weather_city_" + currentTripUuid) || detectTripWeatherCity(trip, tripData);
  const currentCity = WEATHER_CITY_PRESETS.find((c) => c.id === currentCityId) || WEATHER_CITY_PRESETS[0];

  const cityOptions = WEATHER_CITY_PRESETS.map(
    (c) => `<option value="${c.id}" ${c.id === currentCity.id ? "selected" : ""}>${c.name}</option>`
  ).join("");

  const modalHtml = `
    <div class="ef-wrap">
      <div class="ef-label">當前顯示城市</div>
      <div style="font-weight:bold;color:var(--moss);font-size:14px;padding:6px 0;">📍 ${currentCity.name}</div>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">選擇全球熱門城市 (即選即看)</div>
      <select id="selectWeatherCityDropdown" class="ef-select" style="background:#fff;">
        ${cityOptions}
      </select>
    </div>
  `;

  openFormModal({
    title: "🌍 切換旅程氣象城市",
    bodyHtml: modalHtml,
    confirmText: "套用並更新天氣",
    onConfirm: () => {
      const selectedId = document.getElementById("selectWeatherCityDropdown").value;
      if (selectedId && currentTripUuid) {
        localStorage.setItem("trip_weather_city_" + currentTripUuid, selectedId);
      }
      renderWeatherCard(true);
      showToast("已成功更新氣象城市 ✓");
      return true;
    },
  });
}

async function renderWeatherCard(forceRefresh = false) {
  const container = document.getElementById("tripWeatherContainer");
  if (!container) return;

  const trip = tripsList.find((t) => t.uuid === currentTripUuid) || tripData;
  
  // 優先順序：1. 手動自訂偏好 2. 行程設定 3. 自動偵測
  const manualCityId = currentTripUuid ? localStorage.getItem("trip_weather_city_" + currentTripUuid) : null;
  const activeCityId = manualCityId || detectTripWeatherCity(trip, tripData);
  const activeCity = WEATHER_CITY_PRESETS.find((c) => c.id === activeCityId) || WEATHER_CITY_PRESETS[0];

  container.innerHTML = `
    <div class="weather-card">
      <div class="weather-header">
        <div class="weather-title-area">
          <div class="weather-icon-badge">⛅</div>
          <div>
            <div class="weather-title-text" style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;">
              <span>旅程天氣預報</span>
              <span class="weather-location-pill" style="cursor:pointer;" onclick="openCustomWeatherCityModal()" title="點此可自由更換或搜尋其他城市氣象">📍 ${activeCity.name} <span style="font-size:10px;text-decoration:underline;margin-left:2px;opacity:0.85;">[更換]</span></span>
            </div>
          </div>
        </div>
        <div class="weather-controls">
          <div class="weather-tab-switch">
            <button type="button" class="weather-tab-btn ${currentWeatherPeriod === "3day" ? "active" : ""}" onclick="switchWeatherTab('3day')">未來 3 天</button>
            <button type="button" class="weather-tab-btn ${currentWeatherPeriod === "7day" ? "active" : ""}" onclick="switchWeatherTab('7day')">一週預報</button>
          </div>
          <button type="button" class="weather-refresh-btn" onclick="renderWeatherCard(true)" title="重新整理即時氣象">🔄</button>
        </div>
      </div>
      <div id="weatherDaysList" style="text-align:center;padding:18px 0;color:var(--moss);font-size:12px;font-weight:700;">
        ⏳ 正在連線 ${activeCity.name} 即時衛星氣象...
      </div>
    </div>
  `;

  try {
    const data = await fetchWeatherForCity(activeCityId, forceRefresh);
    const listContainer = document.getElementById("weatherDaysList");
    if (!listContainer || !data.daily || !data.daily.time) return;

    const daysToShow = currentWeatherPeriod === "3day" ? 3 : 7;
    const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
    const count = Math.min(daysToShow, data.daily.time.length);

    let html = '<div class="weather-days-row">';
    for (let i = 0; i < count; i++) {
      const dateStr = data.daily.time[i];
      const d = new Date(dateStr);
      const m = d.getMonth() + 1;
      const dayNum = d.getDate();
      const wd = weekdays[d.getDay()];
      const isToday = i === 0;
      const maxTemp = Math.round(data.daily.temperature_2m_max[i]);
      const minTemp = Math.round(data.daily.temperature_2m_min[i]);
      const rainProb = data.daily.precipitation_probability_max ? data.daily.precipitation_probability_max[i] : 0;
      const weatherCode = data.daily.weathercode ? data.daily.weathercode[i] : 0;
      const weatherInfo = getWmoWeatherInfo(weatherCode);

      html += `
        <div class="weather-day-col ${isToday ? "is-today" : ""}">
          ${isToday ? '<span class="weather-today-badge">今日</span>' : ""}
          <div class="weather-day-date">${m}/${dayNum}</div>
          <div class="weather-day-sub">(${wd})</div>
          <div class="weather-day-emoji">${weatherInfo.icon}</div>
          <div class="weather-day-desc">${weatherInfo.text}</div>
          <div class="weather-day-temp">
            <span class="weather-temp-max">${maxTemp}°</span>
            <span style="opacity:0.35;font-weight:normal;margin:0 2px;">/</span>
            <span class="weather-temp-min">${minTemp}°</span>
          </div>
          <div class="weather-day-rain ${rainProb >= 50 ? "high-rain" : ""}">💧 ${rainProb}%</div>
        </div>
      `;
    }
    html += "</div>";
    html += `
      <div class="weather-footer-note">
        <span>Open-Meteo 高解析氣象模型 • 每小時自動快取更新</span>
      </div>
    `;
    listContainer.outerHTML = html;
  } catch (err) {
    const listContainer = document.getElementById("weatherDaysList");
    if (listContainer) {
      listContainer.innerHTML = `
        <div style="padding:14px;background:rgba(255,255,255,0.6);border-radius:12px;font-size:12px;color:#888;border:1px dashed var(--mist);">
          ⛅ 暫時無法取得即時天氣預報（可點擊右上角 🔄 重新整理）
        </div>
      `;
    }
  }
}

function switchWeatherTab(period) {
  currentWeatherPeriod = period;
  renderWeatherCard(false);
}

function onWeatherCitySelectChange(cityId) {
  if (currentTripUuid) {
    localStorage.setItem("trip_weather_city_" + currentTripUuid, cityId);
  }
  renderWeatherCard(false);
}

function isTripUnlocked(tripUuid, tripPassword) {
  if (!tripUuid) return true;
  // 管理員尊榮特權：必須確實持有有效且未過期的 Google 登入 Token
  if (userRole === "admin" && idToken && !isTokenExpired(idToken)) return true;
  // 雙重校驗密碼：優先比對傳入密碼，若無則查詢本機已知加密紀錄，杜絕後端 tripsList 漏回密碼之破口
  const pwd = (tripPassword !== undefined && tripPassword !== null && String(tripPassword).trim())
    ? String(tripPassword).trim()
    : getKnownTripPassword(tripUuid);

  if (!pwd) return true; // 確認完全未設密碼的公開行程：免密碼直接唯讀瀏覽
  // 改為 sessionStorage：關閉分頁、重啟瀏覽器或離開網頁即自動失效登出
  const savedUnlock = sessionStorage.getItem("unlocked_trip_" + tripUuid);
  return savedUnlock === pwd;
}

// 記錄與讀取已知加密行程清單 (徹底解決線上 GAS 未部署時 tripsList 漏掉密碼的問題)
function markTripHasPassword(uuid, password) {
  if (!uuid) return;
  try {
    const list = JSON.parse(localStorage.getItem("known_locked_trips") || "{}");
    list[uuid] = password || true;
    localStorage.setItem("known_locked_trips", JSON.stringify(list));
  } catch (e) {}
}

function getKnownTripPassword(uuid) {
  if (!uuid) return "";
  try {
    const list = JSON.parse(localStorage.getItem("known_locked_trips") || "{}");
    if (list[uuid] && typeof list[uuid] === "string") return list[uuid];
  } catch (e) {}
  try {
    const cached = localStorage.getItem("cache_trip_" + uuid);
    if (cached) {
      const data = JSON.parse(cached);
      if (data && data.password) return String(data.password).trim();
    }
  } catch (e) {}
  return "";
}

function markTripUnlocked(tripUuid, tripPassword) {
  const pwd = tripPassword !== undefined && tripPassword !== null ? String(tripPassword).trim() : "";
  sessionStorage.setItem("unlocked_trip_" + tripUuid, pwd);
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

let pendingUnlockTrip = null;

// 顯示專屬私密行程門禁鎖定畫面 (整塊隱蔽手冊，絕不露出一絲內容)
function showLockedView(trip) {
  pendingUnlockTrip = trip;
  document.getElementById("view-hub").style.display = "none";
  document.getElementById("view-trip").style.display = "none";
  const lockedView = document.getElementById("view-locked");
  if (lockedView) lockedView.style.display = "block";

  const indicator = document.getElementById("currentTripIndicator");
  if (indicator) {
    indicator.style.display = "inline-block";
    indicator.innerText = `🔒 ${(trip && (trip.name || trip.uuid)) || currentTripUuid}`;
  }

  const titleEl = document.getElementById("lockedTripTitle");
  if (titleEl) {
    titleEl.innerText = `🔒【${escapeHtml((trip && (trip.name || trip.uuid)) || currentTripUuid)}】`;
  }

  const pwdInput = document.getElementById("lockedTripPwdInput");
  if (pwdInput) {
    pwdInput.value = "";
    pwdInput.style.borderColor = "var(--mist)";
    pwdInput.focus();
  }

  const errEl = document.getElementById("lockedTripErrorMsg");
  if (errEl) errEl.style.display = "none";
}

// 門禁解鎖表單送出驗證 (0.001 秒本地極速瞬驗 + 零卡頓秒開)
async function handleTripUnlockSubmit(e) {
  if (e) e.preventDefault();
  const inputEl = document.getElementById("lockedTripPwdInput");
  const errEl = document.getElementById("lockedTripErrorMsg");
  const inputPwd = (inputEl ? inputEl.value : "").trim();

  if (!inputPwd) {
    alert("請輸入存取密碼！");
    return;
  }

  const trip = pendingUnlockTrip || tripsList.find((t) => t.uuid === currentTripUuid) || (tripData && tripData.uuid === currentTripUuid ? tripData : { uuid: currentTripUuid, password: "" });
  const expectedPwd = String((trip && trip.password) || getKnownTripPassword(currentTripUuid) || "").trim();

  // 1. 若本機已知密碼：0.001 秒極速秒驗秒開，完全不需要浪費 3~5 秒乾等網路！
  if (expectedPwd) {
    if (inputPwd !== expectedPwd) {
      if (errEl) {
        errEl.innerText = "❌ 密碼錯誤，請重新輸入！";
        errEl.style.display = "block";
      }
      if (inputEl) {
        inputEl.style.borderColor = "var(--red)";
        inputEl.select();
      }
      return;
    }

    // 密碼完全正確：瞬間授權解鎖並進入手冊
    markTripUnlocked(currentTripUuid, inputPwd);
    markTripHasPassword(currentTripUuid, inputPwd);
    showToast("密碼驗證成功，手冊已解鎖 ✓");

    const lockedView = document.getElementById("view-locked");
    if (lockedView) lockedView.style.display = "none";

    showTripView();
    initCountdown();
    render();

    // 在背景靜默同步最新資料 (完全不阻擋使用者操作)
    fetchTripData();
    return;
  }

  // 2. 若本機尚未知曉密碼 (初次訪問且尚未同步)：向後端請求驗證並同步解鎖資料
  showLoading("正在驗證密碼，請稍候...");
  try {
    const tokenParam = idToken ? `&token=${encodeURIComponent(idToken)}` : "";
    const res = await fetch(
      `${GAS_API_URL}?action=getTripData&tripUuid=${encodeURIComponent(
        currentTripUuid,
      )}&tripPassword=${encodeURIComponent(inputPwd)}${tokenParam}`,
    );
    const result = await res.json();
    hideLoading();

    if (result.status === "locked" || result.status === "error") {
      if (errEl) {
        errEl.innerText = result.message || "❌ 密碼錯誤，請重新輸入！";
        errEl.style.display = "block";
      }
      if (inputEl) {
        inputEl.style.borderColor = "var(--red)";
        inputEl.select();
      }
      return;
    }

    if (result.status === "success") {
      markTripUnlocked(currentTripUuid, inputPwd);
      markTripHasPassword(currentTripUuid, inputPwd);
      showToast("密碼驗證成功，手冊已解鎖 ✓");

      tripData = sanitizeAndDeduplicateTrip(result.data);
      if (tripData && tripData.days) {
        sortTripDays(tripData.days);
      }
      try {
        localStorage.setItem("cache_trip_" + currentTripUuid, JSON.stringify(tripData));
      } catch (e) {}

      const lockedView = document.getElementById("view-locked");
      if (lockedView) lockedView.style.display = "none";

      showTripView();
      initCountdown();
      render();
    }
  } catch (err) {
    hideLoading();
    alert("驗證連線失敗，請檢查網路連線後重試");
  }
}

// 點擊大廳行程卡片時的安全進入路由
function openTripByUuid(uuid) {
  const trip = tripsList.find((t) => t.uuid === uuid);
  const tripPassword = (trip && trip.password) || getKnownTripPassword(uuid) || "";
  const hasPassword = Boolean(tripPassword || (trip && trip.hasPassword));

  if (hasPassword && !isTripUnlocked(uuid, tripPassword)) {
    // 進入專屬門禁鎖定畫面，未解鎖前完全不載入手冊內容
    currentTripUuid = uuid;
    const currentPath = window.location.pathname;
    history.pushState({ trip: uuid }, "", `${currentPath}?trip=${encodeURIComponent(uuid)}`);
    showLockedView(trip || { uuid, name: (trip && trip.name) || uuid, password: tripPassword });
    return;
  }

  navigateTo(uuid);
}

function showHubView() {
  // 訪客跳離行程手冊返回大廳時，清空所有解鎖授權，確保再次進入時必須重新輸入密碼
  const isAdmin = userRole === "admin" && idToken && !isTokenExpired(idToken);
  if (!isAdmin) {
    Object.keys(sessionStorage).forEach((key) => {
      if (key.startsWith("unlocked_trip_")) {
        sessionStorage.removeItem(key);
      }
    });
  }
  resetToDefaultTheme();
  document.getElementById("view-hub").style.display = "block";
  document.getElementById("view-trip").style.display = "none";
  const lockedView = document.getElementById("view-locked");
  if (lockedView) lockedView.style.display = "none";
  const adminView = document.getElementById("view-admin");
  if (adminView) adminView.style.display = "none";
  document.getElementById("currentTripIndicator").style.display = "none";
}

// =========================================================================
// 全方位跳離與防呆安全機制 (切換分頁、跳離網站、關閉分頁或 BFCache 返回立即鎖定)
// =========================================================================
// 1. 監聽切換到其他分頁或跳離本頁 (visibilitychange)
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "hidden") {
    const isAdmin = userRole === "admin" && idToken && !isTokenExpired(idToken);
    if (!isAdmin) {
      Object.keys(sessionStorage).forEach((key) => {
        if (key.startsWith("unlocked_trip_")) {
          sessionStorage.removeItem(key);
        }
      });
      if (currentTripUuid) {
        document.getElementById("view-trip").style.display = "none";
        showLockedView({ uuid: currentTripUuid, name: (tripData && tripData.name) || currentTripUuid });
      }
    }
  }
});

// 2. 監聽跳離網頁、切換至其他網址或關閉分頁 (pagehide 與 beforeunload)
window.addEventListener("pagehide", function () {
  const isAdmin = userRole === "admin" && idToken && !isTokenExpired(idToken);
  if (!isAdmin) {
    Object.keys(sessionStorage).forEach((key) => {
      if (key.startsWith("unlocked_trip_")) {
        sessionStorage.removeItem(key);
      }
    });
  }
});

window.addEventListener("beforeunload", function () {
  const isAdmin = userRole === "admin" && idToken && !isTokenExpired(idToken);
  if (!isAdmin) {
    Object.keys(sessionStorage).forEach((key) => {
      if (key.startsWith("unlocked_trip_")) {
        sessionStorage.removeItem(key);
      }
    });
  }
});

// 3. 監聽 pageshow (破除瀏覽器 BFCache 往返快取記憶體快照漏洞)
window.addEventListener("pageshow", function () {
  const isAdmin = userRole === "admin" && idToken && !isTokenExpired(idToken);
  if (currentTripUuid && !isAdmin) {
    const savedUnlock = sessionStorage.getItem("unlocked_trip_" + currentTripUuid);
    if (!savedUnlock) {
      document.getElementById("view-trip").style.display = "none";
      showLockedView({ uuid: currentTripUuid, name: (tripData && tripData.name) || currentTripUuid });
    }
  }
});

function showTripView() {
  const trip = tripsList.find((t) => t.uuid === currentTripUuid) || tripData;
  const tripPassword = trip ? (trip.password || "") : "";
  // 雙重安全閥：若未解鎖，絕對不允許開啟手冊畫面
  if (currentTripUuid && !isTripUnlocked(currentTripUuid, tripPassword)) {
    showLockedView(trip || { uuid: currentTripUuid, name: currentTripUuid, password: tripPassword });
    return;
  }

  currentFoodFilter = "all";
  currentShoppingFilter = "all";
  document.getElementById("view-hub").style.display = "none";
  const lockedView = document.getElementById("view-locked");
  if (lockedView) lockedView.style.display = "none";
  const adminView = document.getElementById("view-admin");
  if (adminView) adminView.style.display = "none";
  document.getElementById("view-trip").style.display = "block";
  const indicator = document.getElementById("currentTripIndicator");
  if (indicator) {
    indicator.style.display = "inline-block";
    indicator.innerText = `📍 ${(trip && trip.name) || currentTripUuid}`;
  }

  // 套用四季與專案主題色彩 (優先以出發季節智能適配：春櫻、夏海、秋楓、冬雪)
  const themeKey = (trip && trip.theme) || (tripData && tripData.theme) || "";
  const tripTitle = (trip && trip.name) || (tripData && tripData.name) || "";
  const tripStartDate = (trip && trip.startDate) || (tripData && tripData.startDate) || "";
  applyTripTheme(themeKey, tripTitle, currentTripUuid, tripStartDate);

  // 渲染未來 3 天 / 一週氣象預報卡片
  renderWeatherCard();
}

// 獨立專屬後台視圖 (完全獨立於所有旅遊行程之外，具備管理員身分持久保持保護)
function showAdminView() {
  // 雙重管理員身分判定：
  let isKnownAdmin = userRole === "admin";
  try {
    const list = JSON.parse(localStorage.getItem("known_admin_emails") || "[]");
    const cachedRole = localStorage.getItem("cache_userRole");
    if (cachedRole === "admin") isKnownAdmin = true;
    if (idToken) {
      const info = parseJwt(idToken);
      const email = info?.email?.toLowerCase().trim();
      if (email && list.includes(email)) isKnownAdmin = true;
    }
  } catch (e) {}

  // 只有在既非已知管理員、又無有效 Token 時才阻擋並導向登入
  if (!isKnownAdmin && (!idToken || isTokenExpired(idToken))) {
    showToast("此管理專區僅限系統管理員存取");
    triggerGoogleLogin();
    showHubView();
    return;
  }

  // 穩定鎖定為管理員，絕不中途降級跳走
  userRole = "admin";
  try { localStorage.setItem("cache_userRole", "admin"); } catch (e) {}

  document.getElementById("view-hub").style.display = "none";
  document.getElementById("view-trip").style.display = "none";
  const lockedView = document.getElementById("view-locked");
  if (lockedView) lockedView.style.display = "none";
  const adminView = document.getElementById("view-admin");
  if (adminView) adminView.style.display = "block";

  const indicator = document.getElementById("currentTripIndicator");
  if (indicator) {
    indicator.style.display = "inline-block";
    indicator.innerText = "⚙️ 系統管理後台";
  }

  const adminUserTag = document.getElementById("adminUserTag");
  if (adminUserTag) {
    if (idToken) {
      const userInfo = parseJwt(idToken);
      const isExp = isTokenExpired(idToken);
      const nameStr = userInfo?.name || userInfo?.email || "管理員";
      adminUserTag.innerHTML = `👑 ${escapeHtml(nameStr)} ${isExp ? '<span style="font-size:11px;text-decoration:underline;cursor:pointer;margin-left:4px;color:#FEF08A;" onclick="triggerGoogleLogin()">[憑證過期點此續期]</span>' : '✓'}`;
    } else {
      adminUserTag.innerText = "👑 系統管理員已就緒";
    }
  }

  resetToDefaultTheme();
  renderAdminView();
}

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
  const urlParams = new URLSearchParams(window.location.search);
  const isAdminRoute = urlParams.get("admin") === "1" || urlParams.get("trip") === "admin";
  if (isAdminRoute) {
    showAdminView();
    return;
  }

  currentTripUuid = getTripUuidFromUrl();
  if (currentTripUuid) {
    const trip = tripsList.find((t) => t.uuid === currentTripUuid);
    const pwd = (trip && trip.password) || getKnownTripPassword(currentTripUuid) || "";
    if (pwd && !isTripUnlocked(currentTripUuid, pwd)) {
      showLockedView(trip || { uuid: currentTripUuid, name: (trip && trip.name) || currentTripUuid, password: pwd });
    } else {
      showTripView();
    }
  } else {
    showHubView();
  }
}

// 路由導航切換函式
function navigateTo(tripUuid) {
  const currentPath = window.location.pathname;

  // 獨立後台中心
  if (tripUuid === "admin") {
    currentTripUuid = "";
    history.pushState({ view: "admin" }, "", `${currentPath}?admin=1`);
    showAdminView();
    return;
  }

  const targetUuid = (tripUuid || "").trim();

  // 若切換至不同行程手冊，徹底清空舊行程之記憶體資料與頁面 DOM，杜絕內容混淆！
  if (targetUuid && targetUuid !== currentTripUuid) {
    tripData = null;
    document.querySelectorAll(".page").forEach((p) => {
      p.innerHTML = '<div style="text-align:center;padding:60px 10px;color:var(--moss);font-size:13px;font-weight:700;">⏳ 正在載入旅程手冊內容...</div>';
    });
  }

  currentTripUuid = targetUuid;
  const newUrl = currentTripUuid
    ? `${currentPath}?trip=${encodeURIComponent(currentTripUuid)}`
    : currentPath;

  history.pushState({ trip: currentTripUuid }, "", newUrl);

  if (currentTripUuid) {
    const trip = tripsList.find((t) => t.uuid === currentTripUuid);
    const tripPassword = (trip && trip.password) || getKnownTripPassword(currentTripUuid) || "";

    if (tripPassword && !isTripUnlocked(currentTripUuid, tripPassword)) {
      showLockedView(trip || { uuid: currentTripUuid, name: (trip && trip.name) || currentTripUuid, password: tripPassword });
      fetchTripData();
    } else {
      showTripView();
      fetchTripData();
    }
  } else {
    showHubView();
    renderHubTripsGrid();
  }
}

// 監聽瀏覽器上一頁/下一頁
window.onpopstate = function () {
  initRouter();
  if (currentTripUuid) {
    fetchTripData();
  } else if (!window.location.search.includes("admin=1")) {
    renderHubTripsGrid();
  }
};

// 初始化流程：DOMContentLoaded 立即觸發，不等網路！
document.addEventListener("DOMContentLoaded", function () {
  initRouter();
  initGoogleAuth();

  // 若當前在手冊頁，嚴格檢查密碼門禁後再決定是否從快取渲染！
  if (currentTripUuid) {
    let tripPassword = "";
    try {
      const cachedTrip = localStorage.getItem("cache_trip_" + currentTripUuid);
      if (cachedTrip) {
        tripData = JSON.parse(cachedTrip);
        tripPassword = tripData.password || "";
      }
      if (!tripPassword) {
        tripPassword = getKnownTripPassword(currentTripUuid);
      }
    } catch (e) {}

    const isAdmin = userRole === "admin" && idToken && !isTokenExpired(idToken);
    const savedUnlock = sessionStorage.getItem("unlocked_trip_" + currentTripUuid);

    // 關鍵門禁：未解鎖時「絕對不渲染手冊內容」，直接顯示門禁鎖定畫面！
    if (!isAdmin && tripPassword && savedUnlock !== tripPassword) {
      showLockedView({ uuid: currentTripUuid, name: (tripData && tripData.name) || currentTripUuid, password: tripPassword });
    } else if (isAdmin || savedUnlock) {
      showTripView();
      if (tripData) {
        initCountdown();
        render();
      }
    } else {
      // 尚未確定密碼狀態：先顯示安全載入提示，由 fetchTripData 進行門禁確認
      showLoading("正在驗證存取權限，請稍候...");
    }
  } else if (window.location.search.includes("admin=1") || window.location.search.includes("trip=admin")) {
    // 若在後台頁，保持後台渲染，絕不執行大廳渲染！
    renderAdminView();
  } else {
    // 若在大廳頁，立即渲染大廳卡片！
    renderHubTripsGrid();
  }

  // 在背景靜默連線 Google Apps Script 同步最新數據
  fetchTrips();
});

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
  const adminCapsule = document.getElementById("adminCapsule");
  const headerLoginBtn = document.getElementById("headerLoginBtn");

  const isAdmin = userRole === "admin" && idToken && !isTokenExpired(idToken);

  // 右上方整合膠囊 [ 🛠️ 後台 ｜ 登出 ] 與快捷登入狀態控制
  if (adminCapsule) {
    adminCapsule.style.display = isAdmin ? "inline-flex" : "none";
  }
  if (headerLoginBtn) {
    headerLoginBtn.style.display = !isAdmin ? "inline-flex" : "none";
  }

  // 徹底杜絕「兩個登出」：管理員已有 adminCapsule 內的登出按鈕，獨立 logoutBtn 強制隱藏！
  if (logoutBtn) {
    logoutBtn.style.display = (!isAdmin && idToken) ? "inline-flex" : "none";
  }

  if (!badge) return;

  if (idToken) {
    const userInfo = parseJwt(idToken);
    const userName = userInfo?.name || userInfo?.email?.split("@")[0] || "使用者";
    const expired = isTokenExpired(idToken);

    if (loginBtn) loginBtn.style.display = "none";

    if (userRole === "admin") {
      badge.className = "user-badge badge-admin";
      if (expired) {
        // 憑證真過期時才提示續期
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
      // 只有在 Token 真正過期時才顯示已逾期；Token 尚未過期時絕不誤報逾期！
      if (expired) {
        badge.className = "user-badge badge-guest";
        badge.innerHTML = `⚠️ 登入已逾期 (${escapeHtml(userName)}) <span style="font-size:11px;text-decoration:underline;cursor:pointer;margin-left:4px;" onclick="triggerGoogleLogin()">[點此重新登入]</span>`;
      } else {
        badge.className = "user-badge badge-guest";
        badge.innerText = `👤 訪客已登入 (${userName})`;
      }
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

// 點擊頂部導覽列右上方「🛠️ 後台」按鈕 (獨立後台視圖，不在各旅遊行程中佔用分頁)
function openAdminView() {
  if (userRole !== "admin" || !idToken || isTokenExpired(idToken)) {
    showToast("請先登入管理員帳號");
    triggerGoogleLogin();
    return;
  }
  navigateTo("admin");
}

function openAdminPanelFromHeader() {
  openAdminView();
}

// 獨立管理中心 Modal (完全獨立於各旅遊行程之外)
function openAdminCenterModal() {
  if (userRole !== "admin" || !idToken || isTokenExpired(idToken)) {
    showToast("請先登入管理員帳號");
    triggerGoogleLogin();
    return;
  }

  const currentTrip = tripsList.find((t) => t.uuid === currentTripUuid);
  const currentBanner = currentTrip
    ? `
      <div style="background:#F0F7FF;border:1px solid #BAE6FD;border-radius:12px;padding:12px 14px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:11px;color:#0369A1;font-weight:700;">📍 當前瀏覽手冊</div>
          <div style="font-size:14px;font-weight:900;color:#0C4A6E;margin-top:2px;">${escapeHtml(currentTrip.name)} <span style="font-size:11px;color:#64748B;font-weight:normal;">(${escapeHtml(currentTrip.uuid)})</span></div>
        </div>
        <button class="btn-mini" onclick="closeModal();openEditTripMetaModal('${escapeHtml(currentTrip.uuid)}')" style="background:#0284C7;color:#fff;border:none;">✏️ 編輯此行程</button>
      </div>
    `
    : "";

  const tripsItems =
    tripsList.length === 0
      ? `<div style="text-align:center;padding:24px;color:#888;font-size:13px;">目前尚無行程，請點擊上方按鈕建立</div>`
      : tripsList
          .map(
            (t) => `
        <div style="background:#FFF;border-radius:12px;padding:12px 14px;margin-bottom:10px;border:1px solid #E2E8F0;box-shadow:0 1px 4px rgba(0,0,0,0.03);">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <span style="font-weight:800;font-size:14px;color:#1E293B;">${escapeHtml(t.name)}</span>
              <span style="font-size:11px;color:#64748B;margin-left:6px;background:#F1F5F9;padding:2px 6px;border-radius:4px;">${escapeHtml(t.uuid)}</span>
            </div>
            <div style="display:flex;gap:6px;">
              <button class="btn-mini" onclick="closeModal();navigateTo('${escapeHtml(t.uuid)}')">📖 開啟</button>
              <button class="btn-mini" onclick="closeModal();openEditTripMetaModal('${escapeHtml(t.uuid)}')">✏️ 設定</button>
            </div>
          </div>
          <div style="font-size:11px;color:#64748B;margin-top:6px;line-height:1.6;">
            <div>🗓️ 期間：${escapeHtml(t.startDate || "")} ~ ${escapeHtml(t.endDate || "")} (${escapeHtml(t.duration || calculateTripDuration(t.startDate, t.endDate) || "未註記天數")})</div>
            <div>🔐 密碼：<span style="font-family:monospace;font-weight:700;color:#0F766E;">${escapeHtml(t.password || "未設密碼 (公開)")}</span> ｜ 👥 授權：${escapeHtml(t.allowed_users || "僅管理員")}</div>
          </div>
        </div>
      `
          )
          .join("");

  const modalHtml = `
    <div style="max-height:68vh;overflow-y:auto;padding-right:2px;">
      ${currentBanner}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <span style="font-size:13px;font-weight:800;color:#334155;">📋 全站行程管理 (${tripsList.length})</span>
        <div style="display:flex;gap:6px;">
          <button class="glass-btn" style="background:#0F766E;color:#fff;padding:5px 10px;font-size:11px;border-radius:8px;" onclick="closeModal();openCreateTripModal()">➕ 建立新行程</button>
        </div>
      </div>
      <div>
        ${tripsItems}
      </div>
    </div>
  `;

  openFormModal({
    title: "⚙️ 系統後台管理中心",
    bodyHtml: modalHtml,
    confirmText: "關閉後台",
    onConfirm: () => true,
  });
}

// 頂部膠囊登出按鈕
function triggerGoogleLogout() {
  logout();
}

// 登入成功回呼 (0.001 秒極速瞬間切換管理員，完全免乾等網路延遲！)
function handleCredentialResponse(response) {
  closeGoogleLoginModal();
  idToken = response.credential;
  localStorage.setItem("google_id_token", idToken);

  const userInfo = parseJwt(idToken);
  const userEmail = userInfo?.email ? userInfo.email.toLowerCase().trim() : "";
  const userName = userInfo?.name || userEmail.split("@")[0] || "使用者";

  // 1. 本地身分智庫即時比對：若為已知管理員或曾授權之 admin
  let knownAdminEmails = [];
  try {
    knownAdminEmails = JSON.parse(localStorage.getItem("known_admin_emails") || "[]");
  } catch (e) {}

  const cachedRole = localStorage.getItem("cache_userRole");
  const isKnownAdmin = knownAdminEmails.includes(userEmail) || cachedRole === "admin";

  if (isKnownAdmin) {
    // 0.001 秒瞬間點亮管理員身分！
    userRole = "admin";
    localStorage.setItem("cache_userRole", "admin");
    updateAuthUI();
    showToast(`👑 歡迎管理員 ${userName}，已瞬間切換身分 ✓`);
  } else {
    updateAuthUI();
    showToast(`歡迎 ${userName}，正在同步權限...`);
  }

  // 背景向 GAS 靜默同步並確保存檔
  fetchTrips().then(() => {
    if (userRole === "admin" && userEmail) {
      try {
        const list = JSON.parse(localStorage.getItem("known_admin_emails") || "[]");
        if (!list.includes(userEmail)) {
          list.push(userEmail);
          localStorage.setItem("known_admin_emails", JSON.stringify(list));
        }
      } catch (e) {}
    }
  });
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
    keywords: ["austria-czech", "austria and czech", "奧捷", "德奧捷", "東歐", "中歐"],
    url: "https://images.unsplash.com/photo-1541849546-216549ae216d?auto=format&fit=crop&w=1200&q=85", // 歐洲古典名城與城堡
    cityTag: "🇪🇺 歐洲 · 奧捷漫遊",
  },
  {
    keywords: ["austria", "奧地利", "vienna", "維也納", "salzburg", "薩爾斯堡", "hallstatt", "哈修塔特", "innsbruck", "因斯布魯克", "wien"],
    url: "https://images.unsplash.com/photo-1516550893923-42d28e5677af?auto=format&fit=crop&w=1200&q=85", // 奧地利哈修塔特湖光山色
    cityTag: "🇦🇹 奧地利 · 維也納",
  },
  {
    keywords: ["czech", "czechia", "捷克", "prague", "布拉格", "praha", "krumlov", "庫倫洛夫", "brno", "布爾諾"],
    url: "https://images.unsplash.com/photo-1519671482749-fd09be7ccebf?auto=format&fit=crop&w=1200&q=85", // 捷克布拉格查理大橋
    cityTag: "🇨🇿 捷克 · 布拉格",
  },
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
      // 權限穩固保護機制：若本地已登入為 admin，只要 Token 尚未逾期，絕不因後端暫時抖動而誤降級為 guest
      if (result.role) {
        if (userRole === "admin" && result.role === "guest" && !isTokenExpired(idToken)) {
          console.warn("後端暫時判定為 guest，但本地 Token 有效且身分為 admin，穩定保留 admin 權限");
        } else {
          userRole = result.role;
        }
      } else {
        if (userRole !== "admin" || isTokenExpired(idToken)) {
          userRole = "guest";
        }
      }
      tripsList = result.trips || [];
      tripsList.forEach((t) => {
        if (t && t.uuid && t.password) {
          markTripHasPassword(t.uuid, t.password);
        }
      });

      if (result.role === "admin" && idToken) {
        const info = parseJwt(idToken);
        if (info && info.email) {
          try {
            const list = JSON.parse(localStorage.getItem("known_admin_emails") || "[]");
            const clean = info.email.toLowerCase().trim();
            if (!list.includes(clean)) {
              list.push(clean);
              localStorage.setItem("known_admin_emails", JSON.stringify(list));
            }
          } catch (e) {}
        }
      }

      // 儲存至本地快取
      try {
        localStorage.setItem("cache_tripsList", JSON.stringify(tripsList));
        localStorage.setItem("cache_userRole", userRole);
      } catch (e) {}

      updateAuthUI();
      const isAdminRoute = window.location.search.includes("admin=1") || window.location.search.includes("trip=admin");
      if (isAdminRoute) {
        renderAdminView();
      } else if (!currentTripUuid) {
        renderHubTripsGrid();
      }

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
      const tripPassword = (t.password && String(t.password).trim()) || getKnownTripPassword(t.uuid) || "";
      const hasPassword = Boolean(tripPassword || t.hasPassword);
      const isUnlocked = isTripUnlocked(t.uuid, tripPassword);

      let lockBadge = "";
      if (hasPassword) {
        if (userRole === "admin") {
          lockBadge = '<span style="flex-shrink:0;white-space:nowrap;font-size:10px;background:rgba(197,160,89,0.18);color:#6B5A2A;padding:2px 8px;border-radius:12px;font-weight:800;border:1px solid var(--gold);">👑 管理員免密</span>';
        } else if (isUnlocked) {
          lockBadge = '<span style="flex-shrink:0;white-space:nowrap;font-size:10px;background:rgba(26,56,34,0.12);color:var(--moss);padding:2px 8px;border-radius:12px;font-weight:800;">🔓 已解鎖</span>';
        } else {
          lockBadge = '<span style="flex-shrink:0;white-space:nowrap;font-size:10px;background:rgba(200,59,43,0.12);color:var(--red);padding:2px 8px;border-radius:12px;font-weight:800;">🔒 密碼保護</span>';
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
                <div class="hub-card-title" style="flex:1;min-width:0;word-break:break-word;">${safeName}</div>
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

  const isAdmin = userRole === "admin";
  const savedUnlockPwd = sessionStorage.getItem("unlocked_trip_" + currentTripUuid) || "";

  // 檢查特定行程是否受密碼保護且尚未解鎖
  function ensureTripUnlockedOrPrompt(data) {
    if (!data) return true;
    if (isAdmin) return true;
    const currentMeta = tripsList.find((t) => t.uuid === currentTripUuid);
    const pwd = (data.password !== undefined ? data.password : (currentMeta ? currentMeta.password : "")) || "";
    if (!pwd) return true;
    if (savedUnlockPwd === pwd) {
      return true;
    }
    // 未解鎖狀態：切換至門禁鎖定畫面，絕不露出任何手冊內容！
    showLockedView({ uuid: currentTripUuid, name: data.name || (currentMeta ? currentMeta.name : "") || currentTripUuid, password: pwd });
    return false;
  }

  // 1. 若本地快取存在且已確認通過門禁或為管理員，才從快取秒開
  let hasCache = false;
  try {
    const cached = localStorage.getItem("cache_trip_" + currentTripUuid);
    if (cached) {
      const parsedData = JSON.parse(cached);
      const cachedPwd = parsedData.password ? String(parsedData.password).trim() : "";
      if (isAdmin || !cachedPwd || savedUnlockPwd === cachedPwd) {
        tripData = sanitizeAndDeduplicateTrip(parsedData);
        if (tripData && tripData.days) {
          sortTripDays(tripData.days);
        }
        hasCache = true;
        const indicator = document.getElementById("currentTripIndicator");
        if (indicator) {
          indicator.style.display = "inline-block";
          indicator.innerText = `📍 ${tripData.name || currentTripUuid}`;
        }
        showTripView();
        initCountdown();
        render();
      } else {
        // 快取含密碼且未解鎖：直接進入門禁鎖定畫面
        showLockedView({ uuid: currentTripUuid, name: parsedData.name || currentTripUuid, password: cachedPwd });
        return;
      }
    }
  } catch (e) {}

  if (!hasCache) {
    showLoading("正在驗證存取權限，請稍候...");
  }

  // 2. 在背景向 Google 試算表靜默同步最新資料，同時帶上 Token 與 Session 解鎖密碼
  try {
    const tokenParam = idToken ? `&token=${encodeURIComponent(idToken)}` : "";
    const pwdParam = savedUnlockPwd ? `&tripPassword=${encodeURIComponent(savedUnlockPwd)}` : "";
    const res = await fetch(
      `${GAS_API_URL}?action=getTripData&tripUuid=${encodeURIComponent(
        currentTripUuid,
      )}${tokenParam}${pwdParam}`,
    );
    const result = await res.json();

    // 關鍵門禁：若後端判定鎖定（未提供密碼或密碼錯誤）
    if (result.status === "locked") {
      try { localStorage.removeItem("cache_trip_" + currentTripUuid); } catch (e) {}
      showLockedView({ uuid: currentTripUuid, name: result.name || currentTripUuid, hasPassword: true });
      return;
    }

    if (result.status === "success") {
      tripData = sanitizeAndDeduplicateTrip(result.data);
      // 權限穩固保護機制：若本地為 admin 且 Token 有效，絕不輕易降級為 guest
      if (result.role) {
        if (userRole === "admin" && result.role === "guest" && !isTokenExpired(idToken)) {
          console.warn("後端暫時判定為 guest，但本地 Token 有效且為 admin，穩定保留 admin 狀態");
        } else {
          userRole = result.role;
        }
      }

      if (tripData && tripData.password) {
        markTripHasPassword(currentTripUuid, tripData.password);
      }

      // 前端二次安全確認：若資料含密碼且尚未解鎖，立即切換為鎖定門禁
      if (!ensureTripUnlockedOrPrompt(tripData)) {
        return;
      }

      if (tripData && tripData.days) {
        sortTripDays(tripData.days);
      }

      // 儲存至本地快取
      try {
        localStorage.setItem("cache_trip_" + currentTripUuid, JSON.stringify(tripData));
        localStorage.setItem("cache_userRole", userRole);
      } catch (e) {}

      // 自動同步日期與天數回 tripsList 與快取
      const tripObj = tripsList.find((t) => t.uuid === currentTripUuid);
      if (tripObj) {
        if (tripData.startDate) tripObj.startDate = tripData.startDate;
        if (tripData.endDate) tripObj.endDate = tripData.endDate;
        if (tripData.duration) tripObj.duration = tripData.duration;
        try {
          localStorage.setItem("cache_tripsList", JSON.stringify(tripsList));
        } catch (e) {}
      }

      updateAuthUI();

      const indicator = document.getElementById("currentTripIndicator");
      if (indicator) {
        indicator.style.display = "inline-block";
        indicator.innerText = `📍 ${tripData.name || currentTripUuid}`;
      }

      showTripView();
      initCountdown();
      render();
      if (hasCache) {
        showToast("手冊資料已同步最新 ✓");
      }
    }
  } catch (e) {
    console.warn("背景同步狀態:", e);
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

// 全局資料安全清洗與去重函式 (防止重複景點、重複美食、幽靈空白路線污染畫面或被二次寫入試算表)
function sanitizeAndDeduplicateTrip(data) {
  if (!data || typeof data !== "object") return data;

  // 1. 行程景點去重與防呆
  if (Array.isArray(data.days)) {
    data.days.forEach((d) => {
      if (!d || typeof d !== "object") return;
      if (!Array.isArray(d.items)) { d.items = []; return; }
      if (d.items.length === 0) return;
      const seen = new Map();
      d.items.forEach((item) => {
        if (!item || typeof item !== "object") return;
        const p = (item.place || "").trim();
        if (!p) return;
        const t = (item.time || "").trim();
        const key = t.toLowerCase() + "___" + p.toLowerCase();
        if (!seen.has(key)) {
          seen.set(key, item);
        } else {
          // 若有重複項目，合併保留較豐富的內容
          const existing = seen.get(key);
          if (!existing.desc && item.desc) existing.desc = item.desc;
          if (!existing.imgUrl && item.imgUrl) existing.imgUrl = item.imgUrl;
          if (!existing.link && item.link) existing.link = item.link;
        }
      });
      d.items = Array.from(seen.values());
    });
  }

  // 2. 美食口袋清單去重
  if (Array.isArray(data.food)) {
    const seenFood = new Map();
    data.food.forEach((f) => {
      if (!f || typeof f !== "object") return;
      const name = (f.name || "").trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (!seenFood.has(key)) {
        seenFood.set(key, f);
      } else {
        const existing = seenFood.get(key);
        if (f.must) existing.must = true;
        if (f.done) existing.done = true;
        if (!existing.desc && f.desc) existing.desc = f.desc;
        if (!existing.imgUrl && f.imgUrl) existing.imgUrl = f.imgUrl;
        if (!existing.area && f.area) existing.area = f.area;
      }
    });
    data.food = Array.from(seenFood.values());
  }

  // 3. 交通乘車行程去重與過濾空白幽靈列
  if (data.transport) {
    if (!Array.isArray(data.transport.passes)) data.transport.passes = [];
    if (!Array.isArray(data.transport.maps)) data.transport.maps = [];
    if (!Array.isArray(data.transport.routes)) data.transport.routes = [];

    const validRoutes = [];
    const seenRoutes = new Set();
    data.transport.routes.forEach((r) => {
      if (!r || typeof r !== "object") return;
      const ft = (r.fromTo || "").trim();
      const ti = (r.trainInfo || "").trim();
      const nt = (r.note || "").trim();
      if (!ft && !ti && !nt) return; // 移除空白幽靈列
      const key = (r.dayTag || "") + "___" + ft + "___" + (r.time || "");
      if (!seenRoutes.has(key)) {
        seenRoutes.add(key);
        validRoutes.push(r);
      }
    });
    data.transport.routes = validRoutes;
  }

  return data;
}

// 即時單筆同步儲存至 Google 試算表（嚴格防呆防覆蓋與防重複保護）
async function save() {
  if (!tripData || !Array.isArray(tripData.days) || tripData.days.length === 0) {
    console.error("tripData 結構不完整或為空，已攔截危險全量覆蓋！");
    return false;
  }

  // 寫入前執行去重與清洗
  tripData = sanitizeAndDeduplicateTrip(tripData);

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
      <input type="text" id="addHotelName" class="ef-input" placeholder="例如: 市中心五星大酒店、精品設計旅宿">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">飯店地址 (供 Google 導航使用)</div>
      <input type="text" id="addHotelAddr" class="ef-input" placeholder="例如: 市中心主要大道 123 號、中央車站旁徒步 3 分鐘">
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
      <input type="text" id="addHotelNote" class="ef-input" placeholder="例如: 車站直結、已含早餐、可免費寄放行李">
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
      <input type="text" id="editHotelNote" class="ef-input" placeholder="例如: 車站直結、附早餐、高樓層景觀" value="${h.note || ""
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
      const dateText = extractMonthDayText(d.date);
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

  // 自動檢測並校正當前天數景點時段順序 (純畫面展示排序，絕不自動呼叫 save() 覆蓋雲端行程)
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
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">
              <div class="tl-place" style="flex:1;min-width:140px;word-break:break-word;">${safePlace}</div>
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
        const oldRawDate = extractMonthDayText(oldDate);
        const newRawDate = extractMonthDayText(newDate);

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

// 輔助函式：自繁中日期文字中安全提取月/日純文字 (同時相容全形與半形括號，例如 "2月16日（二）" 或 "2/16(二)" -> "2/16")
function extractMonthDayText(dateStr) {
  if (!dateStr) return "";
  return String(dateStr)
    .replace(/[\(（].*?[\)）]/g, "")
    .replace("月", "/")
    .replace("日", "")
    .trim();
}

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

// 從繁中日期文字（例如 "2月16日（二）" 或 "2/16"）與參考出發日期推算精確的 ISO 日期 (YYYY-MM-DD)
function parseDateStringToIso(dateText, referenceIsoDate) {
  if (!dateText) return "";
  const trimmed = String(dateText).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const m = trimmed.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/) || trimmed.match(/(\d{1,2})\s*[\/\-]\s*(\d{1,2})/);
  if (m) {
    const month = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    let year = 2027; // 預設年度
    if (referenceIsoDate && /^\d{4}/.test(referenceIsoDate)) {
      year = parseInt(referenceIsoDate.substring(0, 4), 10);
    }
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    return `${year}-${mm}-${dd}`;
  }
  return "";
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

// 全域彈窗連動回呼：新增天數時由日曆選取器同步天數與預覽標籤
window.onAddDayPickerChange = function (newDateStr) {
  if (!newDateStr) return;
  const chineseDate = formatDateToDisplayWithWeekday(newDateStr);
  const preview = document.getElementById("addDayPreview");
  if (preview) preview.innerHTML = `📅 自動顯示：${chineseDate}`;

  // 若有出發日期，自動反推並同步選取天數下拉選單
  if (tripData && tripData.startDate) {
    const dayNum = calculateDayNumFromDate(tripData.startDate, newDateStr);
    if (dayNum && dayNum >= 1 && dayNum <= 14) {
      const select = document.getElementById("addDayId");
      if (select) select.value = `Day ${dayNum}`;
    }
  }
};

// 全域彈窗連動回呼：新增天數時由下拉選單同步日曆與預覽標籤
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
      const preview = document.getElementById("addDayPreview");
      if (preview) preview.innerHTML = `📅 自動顯示：${chineseDate}`;
    }
  }
};

// 全域彈窗連動回呼：編輯天數時由日曆選取器同步預覽標籤
window.onEditDayPickerChange = function (newDateStr) {
  if (!newDateStr) return;
  const chineseDate = formatDateToDisplayWithWeekday(newDateStr);
  const preview = document.getElementById("editDayPreview");
  if (preview) preview.innerHTML = `📅 自動顯示：${chineseDate}`;
};

// 新增行程天數對話框 (全自動計算日期與星期，免手動輸入)
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
      <div class="ef-label">選擇日期 (點選日曆，系統全自動重算星期) <span style="color:var(--red);">*</span></div>
      <input type="date" id="addDayPicker" class="ef-input" value="${defaultIsoDate}" onchange="window.onAddDayPickerChange(this.value)">
      <div id="addDayPreview" class="ef-preview-tag">📅 自動顯示：${defaultDateText || "請點選上方日曆選擇日期"}</div>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">當日行程主題名稱 <span style="color:var(--red);">*</span></div>
      <input type="text" id="addDayTitle" class="ef-input" placeholder="例如: 舊城區漫步 ＆ 經典地標參訪">
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
      const pickerVal = document.getElementById("addDayPicker").value;
      const date = pickerVal ? formatDateToDisplayWithWeekday(pickerVal) : "";

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
  
  // 優先從現有日期文字精準反推 ISO 日期，若無文字再以出發日期推算
  let currentIsoDate = parseDateStringToIso(day.date, tripData.startDate);
  if (!currentIsoDate) {
    const m = (day.id || "").match(/Day\s*(\d+)/i);
    if (m && tripData.startDate) {
      currentIsoDate = calculateIsoDateForDayNum(tripData.startDate, parseInt(m[1], 10));
    }
  }

  const currentDateDisplay = currentIsoDate
    ? formatDateToDisplayWithWeekday(currentIsoDate)
    : (day.date || "尚未設定日期");

  let editPresetOptions = "";
  for (let d = 1; d <= 14; d++) {
    const dayVal = `Day ${d}`;
    editPresetOptions += `<option value="${dayVal}" ${dayVal === day.id ? "selected" : ""}>${dayVal}</option>`;
  }

  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">天數識別 (內建 14 天) <span style="color:var(--red);">*</span></div>
      <select id="editDayId" class="ef-select">
        ${editPresetOptions}
      </select>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">選擇日期 (更換日曆自動重算星期) <span style="color:var(--red);">*</span></div>
      <input type="date" id="editDayPicker" class="ef-input" value="${currentIsoDate}" onchange="window.onEditDayPickerChange(this.value)">
      <div id="editDayPreview" class="ef-preview-tag">📅 自動顯示：${currentDateDisplay}</div>
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
      const pickerVal = document.getElementById("editDayPicker").value;
      const date = pickerVal ? formatDateToDisplayWithWeekday(pickerVal) : (day.date || "");

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
      const oldRawDate = extractMonthDayText(oldDate);
      const newRawDate = extractMonthDayText(date);

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
// 智慧美食去重函式 (依店家名稱為唯一 Key，智慧合併描述、圖片、已品嚐與必吃標記)
function deduplicateFoodList(list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const map = new Map();
  list.forEach((item) => {
    const name = (item.name || "").trim();
    if (!name) return;
    if (!map.has(name)) {
      map.set(name, { ...item, name });
    } else {
      const existing = map.get(name);
      if (!existing.desc && item.desc) existing.desc = item.desc;
      if (!existing.area && item.area) existing.area = item.area;
      if (!existing.imgUrl && item.imgUrl) existing.imgUrl = item.imgUrl;
      if (!existing.emoji && item.emoji) existing.emoji = item.emoji;
      if (item.must) existing.must = true;
      if (item.done) existing.done = true;
    }
  });
  return Array.from(map.values());
}

// 智慧提取或辨識美食所屬地區 (優先使用自訂 area，次之從名稱或說明辨識常見地區關鍵字)
function extractFoodArea(item) {
  if (!item) return "";
  if (item.area && item.area.trim()) {
    return item.area.trim();
  }
  const fullText = `${item.name || ""} ${item.desc || ""}`;
  const commonAreas = [
    "維也納", "布拉格", "薩爾斯堡", "哈修塔特", "庫倫洛夫", "因斯布魯克", "布達佩斯", "巴黎", "倫敦", "蘇黎世", "羅馬", "慕尼黑",
    "東京", "京都", "大阪", "福岡", "札幌", "沖繩", "岡山", "倉敷", "高松", "台北", "高雄", "首爾", "曼谷"
  ];
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
  if (!Array.isArray(tripData.food)) tripData.food = [];

  // 安全去重顯示：僅在畫面渲染時智慧過濾重複店家，絕不自動觸發全量 save() 覆蓋雲端行程
  const list = deduplicateFoodList(tripData.food);
  tripData.food = list;
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
        <div class="food-card" style="${item.done ? "opacity:0.6;" : ""}">
          <!-- 頂部店名與狀態列 (滿版 100% 寬度不擠壓，徹底根除窄螢幕直條擠字) -->
          <div class="food-card-header">
            <div class="food-card-title-wrap">
              <span class="food-card-name" style="${item.done ? "text-decoration:line-through;color:#888;" : ""}">
                ${safeName}
              </span>
              ${item.must
          ? '<span class="food-tag-badge" style="background:var(--red);color:#fff;">🔥 必吃</span>'
          : ""
        }
              ${detectedArea
          ? `<span class="food-tag-badge" style="background:var(--washi);color:var(--moss);border:1px solid rgba(26,56,34,0.2);font-weight:600;">📍 ${escapeHtml(detectedArea)}</span>`
          : ""
        }
            </div>
            <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
              ${adminActions}
              <button onclick="toggleFoodDone(${i})" style="border:none;border-radius:14px;padding:5px 12px;font-size:11px;font-weight:bold;cursor:pointer;background:${item.done ? "var(--moss)" : "var(--mist)"};color:${item.done ? "#fff" : "#666"};transition:all 0.2s;white-space:nowrap;">
                ${item.done ? "已品嚐 ✓" : "想吃"}
              </button>
            </div>
          </div>

          <!-- 卡片內容區：左側縮圖/圖示，右側導航與心得介紹 -->
          <div class="food-card-body">
            <div class="food-card-img-wrap">
              ${hasImg
          ? `<img src="${safeImgUrl}" referrerpolicy="no-referrer" loading="lazy" class="shopping-thumb" onerror="handleImgError(this)" alt="${safeName}">`
          : `<span style="font-size:32px;display:inline-block;opacity:${item.done ? 0.35 : 1};line-height:1;">${safeEmoji}</span>`
        }
            </div>

            <div class="food-card-content">
              ${autoMapUrl ? `<div style="margin-bottom:6px;"><a class="map-link" style="margin-top:0;display:inline-flex;" href="${autoMapUrl}" target="_blank" rel="noopener noreferrer">🗺 地圖導航</a></div>` : ""}
              ${safeDesc ? `<div style="font-size:12px;color:#555;background:#FAF8F5;padding:8px 12px;border-radius:8px;border:1px dashed var(--mist);line-height:1.5;word-break:break-word;">${safeDesc}</div>` : ""}
            </div>
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
      <div class="ef-label">地區/分區 (例如: 老城區、市中心、河畔大道，選填)</div>
      <input type="text" id="editFoodArea" class="ef-input" placeholder="例如: 老城區、市中心、河畔大道" value="${item.area || extractFoodArea(item) || ""}">
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
      <input type="text" id="addFoodName" class="ef-input" placeholder="例如: 舊城區景觀餐廳、在地經典百年老店">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">地區/分區 (例如: 老城區、市中心、河畔大道，選填)</div>
      <input type="text" id="addFoodArea" class="ef-input" placeholder="例如: 老城區、市中心、河畔大道">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">特色說明或推薦菜色</div>
      <input type="text" id="addFoodDesc" class="ef-input" placeholder="例如: 招牌酥脆炸特餐、特製私房甜點、必喝咖啡">
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

      // 重複店家名稱防呆檢查
      const isDuplicate = tripData.food.some(
        (f) => (f.name || "").trim().toLowerCase() === name.toLowerCase()
      );
      if (isDuplicate) {
        alert(`「${name}」已經在您的美食口袋名單中囉！請勿重複新增。`);
        return false;
      }

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
      <input type="text" id="addShoppingName" class="ef-input" placeholder="例如: 特色紀念品、當地名產禮盒、免稅精品">
    </div>
    <div style="display:flex;gap:10px;">
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">數量 (例如: 1、2盒、3瓶)</div>
        <input type="text" id="addShoppingQty" class="ef-input" placeholder="例如: 1 或 2瓶" value="1">
      </div>
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">預估價格 / 預算 (選填)</div>
        <input type="text" id="addShoppingPrice" class="ef-input" placeholder="例如: €25 或 NT$ 1,200">
      </div>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">購買地點 / 店名 (輸入後自動產生 Google 地圖導航按鈕)</div>
      <input type="text" id="addShoppingLocation" class="ef-input" placeholder="例如: 市中心旗艦店、大型連鎖超市、特色市集">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">參考網址 (商品介紹或線上商城連結，選填)</div>
      <input type="text" id="addShoppingLink" class="ef-input" placeholder="https://...">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">備註說明 (規格、色號、退稅注意事項等)</div>
      <textarea id="addShoppingNote" class="ef-textarea" placeholder="例如: 買2盒、需退稅、請認明特定包裝"></textarea>
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
      <input type="text" id="editShoppingLocation" class="ef-input" placeholder="例如: 市中心旗艦店、大型連鎖超市、特色市集" value="${item.location || ""}">
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
// 6. 後台管理系統 (Admin Console) - 獨立視圖管理與即時同步
// =========================================================================
function renderAdmin() {
  if (userRole !== "admin") return;
  renderAdminView();
}

function renderAdminView() {
  const container = document.getElementById("adminTripsContainer");
  const notice = document.getElementById("adminTripCountNotice");
  if (!container) return;

  if (notice) {
    notice.innerText = `目前共綁定 ${tripsList.length} 個旅遊行程`;
  }

  if (tripsList.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:48px 16px;background:var(--card-bg, #fff);border-radius:20px;border:1.5px dashed var(--gold);box-shadow:var(--glass-shadow);">
        <div style="font-size:42px;margin-bottom:12px;">🗺️</div>
        <h3 style="font-size:16px;font-weight:bold;color:var(--moss);margin-bottom:6px;">尚未建立任何旅遊行程</h3>
        <p style="color:#888;font-size:13px;margin-bottom:18px;">立即建立您的第一本專屬旅遊手冊，開始規劃雲端行程！</p>
        <button class="glass-btn" style="background:var(--moss-gradient);color:#fff;display:inline-flex;padding:10px 20px;" onclick="openCreateTripModal()">＋ 立即建立第一筆行程</button>
      </div>
    `;
    return;
  }

  const cardsHtml = tripsList
    .map((t) => {
      const safeName = escapeHtml(t.name);
      const safeUuid = escapeHtml(t.uuid);

      // 深度提取日期與天數 (優先讀取屬性，次讀取本地快取或當前 tripData)
      let cachedData = null;
      try {
        const c = localStorage.getItem("cache_trip_" + t.uuid);
        if (c) cachedData = JSON.parse(c);
      } catch (e) {}

      const sDate = t.startDate || (cachedData ? cachedData.startDate : "") || (tripData && currentTripUuid === t.uuid ? tripData.startDate : "");
      const eDate = t.endDate || (cachedData ? cachedData.endDate : "") || (tripData && currentTripUuid === t.uuid ? tripData.endDate : "");
      const calculatedDur = calculateTripDuration(sDate, eDate);
      const rawDur = t.duration || (cachedData ? cachedData.duration : "") || (tripData && currentTripUuid === t.uuid ? tripData.duration : "");
      const dur = (rawDur && rawDur.trim() && rawDur.trim() !== "未註記天數") ? rawDur.trim() : (calculatedDur || "未註記天數");
      const dateRange = (sDate && eDate) ? `${escapeHtml(sDate)} ~ ${escapeHtml(eDate)}` : (sDate ? escapeHtml(sDate) : "未設日期");

      // 補齊物件屬性供全域使用
      if (sDate) t.startDate = sDate;
      if (eDate) t.endDate = eDate;
      if (dur && dur !== "未註記天數") t.duration = dur;

      const sheetUrl = t.sheet_id ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(t.sheet_id)}` : "";
      const folderUrl = t.folder_id ? `https://drive.google.com/drive/folders/${encodeURIComponent(t.folder_id)}` : "";
      const pwdDisplay = t.password ? `<span style="font-family:monospace;background:#FEF3C7;color:#92400E;padding:2px 8px;border-radius:6px;font-weight:bold;">${escapeHtml(t.password)}</span>` : '<span style="color:#059669;font-weight:bold;">公開無密碼</span>';
      const usersDisplay = t.allowed_users ? escapeHtml(t.allowed_users) : '<span style="color:#999;">僅限系統管理員</span>';

      return `
        <div style="background:var(--card-bg,#fff);border-radius:18px;padding:20px;margin-bottom:16px;border:1px solid var(--mist);box-shadow:0 4px 16px rgba(0,0,0,0.04);transition:all 0.2s ease;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;">
            <div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <span style="font-weight:900;font-size:17px;color:var(--moss);">${safeName}</span>
                <span style="font-size:11px;color:#666;background:#F1F5F9;padding:2px 8px;border-radius:6px;font-family:monospace;">${safeUuid}</span>
              </div>
              <div style="font-size:12px;color:#666;margin-top:4px;">
                🗓️ <b>${dateRange}</b> ｜ ⏱️ ${dur}
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="btn-mini" onclick="navigateTo('${safeUuid}')" style="background:var(--moss);color:#fff;padding:6px 12px;border-radius:8px;">📖 瀏覽手冊</button>
              <button class="btn-mini" onclick="openEditTripMetaModal('${safeUuid}')" style="background:#0284C7;color:#fff;padding:6px 12px;border-radius:8px;">✏️ 編輯設定</button>
            </div>
          </div>

          <div style="margin-top:14px;padding-top:12px;border-top:1px dashed #E2E8F0;font-size:12px;color:#555;line-height:1.8;">
            <div style="display:flex;flex-wrap:wrap;gap:12px;">
              <div>🔐 存取密碼：${pwdDisplay}</div>
              <div>👥 授權人員：${usersDisplay}</div>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:4px;">
              <div>📄 Google 試算表：${sheetUrl ? `<a href="${sheetUrl}" target="_blank" rel="noopener noreferrer" style="color:#2563EB;text-decoration:underline;font-weight:bold;">開啟雲端試算表 ↗</a>` : '<span style="color:#999;">尚未綁定</span>'}</div>
              <div>📁 雲端圖片資料夾：${folderUrl ? `<a href="${folderUrl}" target="_blank" rel="noopener noreferrer" style="color:#2563EB;text-decoration:underline;font-weight:bold;">開啟雲端硬碟相簿 ↗</a>` : '<span style="color:#999;">尚未綁定</span>'}</div>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  container.innerHTML = cardsHtml;
}

async function refreshAdminData() {
  showLoading("正在同步最新行程資訊...");
  try {
    await fetchTrips();
    renderAdminView();
    showToast("全站行程資料已最新同步 ✓");
  } catch (e) {
    showToast("同步失敗，請檢查網路連線");
  } finally {
    hideLoading();
  }
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
      <div class="ef-label">🎨 專案主題色彩</div>
      <select id="newTripTheme" class="ef-input" style="background:#fff;">
        <option value="" selected>🔄 依出發季節自動智能適配 (春櫻 / 夏海 / 秋楓 / 冬雪)</option>
        <option value="winter">❄️ 冬季 • 霜雪冰晶藍 (12~2月冬季與雪景)</option>
        <option value="spring">🌸 春季 • 霞櫻緋粉 (3~5月賞櫻春旅)</option>
        <option value="summer">🌊 夏季 • 碧海琉璃 (6~8月海島渡假)</option>
        <option value="autumn">🍁 秋季 • 丹楓琥珀 (9~11月賞楓金秋)</option>
        <option value="classic">🌿 經典 • 常磐和風 (日系文青苔綠)</option>
        <option value="lavender">🪻 特色 • 輕奢薰衣草 (高雅霧灰紫)</option>
      </select>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">🔐 旅程專屬存取密碼 <span style="font-weight:normal;color:#888;">(選填，留空為公開手冊，有設密碼訪客需輸入密碼唯讀)</span></div>
      <input type="text" id="newTripPassword" class="ef-input" placeholder="例如: travel2028 (選填)">
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
      const theme = document.getElementById("newTripTheme")?.value || "violet";
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
            theme,
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

function autoSyncEditTripDuration() {
  const s = document.getElementById("editTripStartDate")?.value;
  const e = document.getElementById("editTripEndDate")?.value;
  if (s && e) {
    const d1 = new Date(s + "T00:00:00");
    const d2 = new Date(e + "T00:00:00");
    const diffDays = Math.round((d2 - d1) / (1000 * 60 * 60 * 24)) + 1;
    if (diffDays > 0) {
      const nights = diffDays - 1;
      const durationInput = document.getElementById("editTripDuration");
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

  // 深度優先從行程物件、本地快取或當前 tripData 中取出原本設定的日期與天數
  let cachedData = null;
  try {
    const c = localStorage.getItem("cache_trip_" + uuid);
    if (c) cachedData = JSON.parse(c);
  } catch (e) {}

  const currentStartDate = trip.startDate || (cachedData ? cachedData.startDate : "") || (tripData && currentTripUuid === uuid ? tripData.startDate : "");
  const currentEndDate = trip.endDate || (cachedData ? cachedData.endDate : "") || (tripData && currentTripUuid === uuid ? tripData.endDate : "");
  const currentDuration = trip.duration || (cachedData ? cachedData.duration : "") || (tripData && currentTripUuid === uuid ? tripData.duration : "") || calculateTripDuration(currentStartDate, currentEndDate);
  const currentTheme =
    trip.theme || (cachedData ? cachedData.theme : "") || (tripData && currentTripUuid === uuid ? tripData.theme : "") || getAutoThemeKeyForTrip(trip.name, trip.uuid);

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
        <input type="date" id="editTripStartDate" class="ef-input" value="${currentStartDate}" onchange="autoSyncEditTripDuration()">
      </div>
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">結束日期</div>
        <input type="date" id="editTripEndDate" class="ef-input" value="${currentEndDate}" onchange="autoSyncEditTripDuration()">
      </div>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">天數說明 (自動依日期計算，亦可微調)</div>
      <input type="text" id="editTripDuration" class="ef-input" value="${currentDuration}" placeholder="例如: 8天7夜">
    </div>
    <div class="ef-wrap">
      <div class="ef-label">🎨 專案主題色彩</div>
      <select id="editTripTheme" class="ef-input" style="background:#fff;">
        <option value="" ${!currentTheme ? "selected" : ""}>🔄 依出發季節自動智能適配 (春櫻 / 夏海 / 秋楓 / 冬雪)</option>
        <option value="winter" ${currentTheme === "winter" ? "selected" : ""}>❄️ 冬季 • 霜雪冰晶藍 (12~2月冬季與雪景)</option>
        <option value="spring" ${currentTheme === "spring" ? "selected" : ""}>🌸 春季 • 霞櫻緋粉 (3~5月賞櫻春旅)</option>
        <option value="summer" ${currentTheme === "summer" ? "selected" : ""}>🌊 夏季 • 碧海琉璃 (6~8月海島渡假)</option>
        <option value="autumn" ${currentTheme === "autumn" ? "selected" : ""}>🍁 秋季 • 丹楓琥珀 (9~11月賞楓金秋)</option>
        <option value="classic" ${currentTheme === "classic" ? "selected" : ""}>🌿 經典 • 常磐和風 (日系文青苔綠)</option>
        <option value="lavender" ${currentTheme === "lavender" ? "selected" : ""}>🪻 特色 • 輕奢薰衣草 (高雅霧灰紫)</option>
      </select>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">授權人員 Email (以英文逗號分隔)</div>
      <textarea id="editTripAllowedUsers" class="ef-textarea">${trip.allowed_users || ""}</textarea>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">🔐 旅程專屬存取密碼 <span style="font-weight:normal;color:#888;">(選填，留空即取消密碼變為公開手冊)</span></div>
      <input type="text" id="editTripPassword" class="ef-input" value="${trip.password || ""}" placeholder="例如: travel2028 (選填)">
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
      const theme = document.getElementById("editTripTheme")?.value || "violet";
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
            theme,
            allowedUsers,
            password,
          }),
        });
        const result = await res.json();
        if (result.status === "success") {
          showToast("行程設定更新成功 ✓");
          trip.name = name;
          trip.startDate = startDate;
          trip.endDate = endDate;
          trip.duration = duration;
          trip.password = password;
          trip.theme = theme;
          trip.allowed_users = allowedUsers;

          // 同步更新本地快取
          try {
            const c = localStorage.getItem("cache_trip_" + uuid);
            if (c) {
              const d = JSON.parse(c);
              d.name = name;
              d.startDate = startDate;
              d.endDate = endDate;
              d.duration = duration;
              d.password = password;
              d.theme = theme;
              localStorage.setItem("cache_trip_" + uuid, JSON.stringify(d));
            }
            localStorage.setItem("cache_tripsList", JSON.stringify(tripsList));
          } catch(e) {}

          // 若修改的是當前行程，同步更新記憶體資料並即時變換主題色
          if (currentTripUuid === uuid && tripData) {
            tripData.name = name;
            tripData.startDate = startDate;
            tripData.endDate = endDate;
            tripData.duration = duration;
            tripData.password = password;
            tripData.theme = theme;
            initCountdown();
            applyTripTheme(theme, name, uuid, startDate);
          }
          
          renderAdminView();
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

      // 智能辨識備註中是否包含超連結網址
      let noteContent = "";
      if (safeNote) {
        if (safeNote.startsWith("http://") || safeNote.startsWith("https://")) {
          noteContent = `<a href="${safeNote}" target="_blank" rel="noopener noreferrer" style="font-size:11px;color:var(--gold-glow);margin-left:6px;text-decoration:underline;font-weight:700;" onclick="event.stopPropagation();" title="${safeNote}">🔗 官網連結</a>`;
        } else {
          noteContent = `<span style="font-size:11px;margin-left:6px;opacity:0.9;">· ${safeNote}</span>`;
        }
      }

      const adminPassActions = isAdmin
        ? `
          <div style="display:inline-flex;align-items:center;gap:4px;margin-left:8px;">
            <button class="btn-mini" style="background:rgba(255,255,255,0.25);color:#fff;border-color:rgba(255,255,255,0.4);padding:2px 7px;font-size:11px;" onclick="event.stopPropagation();openEditTransitPassModal(${idx})">✏️ 修改</button>
            <button class="btn-mini btn-mini-danger" style="padding:2px 7px;font-size:11px;" onclick="event.stopPropagation();deleteTransitPass(${idx})">✕</button>
          </div>
        `
        : "";

      return `
      <div style="background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.35);padding:6px 12px;border-radius:12px;display:inline-flex;align-items:center;margin-top:6px;margin-right:6px;flex-wrap:wrap;max-width:100%;${isAdmin ? 'cursor:pointer;' : ''}" ${isAdmin ? `onclick="openEditTransitPassModal(${idx})"` : ""}>
        <span style="font-weight:800;font-size:12px;">🎟️ ${safePassName}</span>
        ${safeCost ? `<span style="font-size:11px;margin-left:6px;opacity:0.95;font-weight:700;">(${safeCost} ${safeCurr})</span>` : ""}
        ${noteContent}
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
    const rawDate = extractMonthDayText(d.date);
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
      <input type="text" id="addTransFromTo" class="ef-input" placeholder="例如: 機場～市區快線、中央車站到舊城區">
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
        <div class="ef-label">車種名稱 (例如: 特快列車、機場巴士、地鐵)</div>
        <input type="text" id="addTransTrain" class="ef-input" placeholder="例如: 機場快線、國鐵城際列車、觀光巴士">
      </div>
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">劃位/座位資訊</div>
        <input type="text" id="addTransSeat" class="ef-input" placeholder="例如: 2號車廂 15A、自由席、Bus 2號口">
      </div>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">備註事項 (月台、轉乘、換券說明)</div>
      <textarea id="addTransNote" class="ef-textarea" placeholder="例如: 第2月台搭乘、於中央車站轉乘地下鐵"></textarea>
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
    const rawDate = extractMonthDayText(d.date);
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

// 編輯周遊券對話框
function openEditTransitPassModal(idx) {
  if (!tripData.transport || !tripData.transport.passes || !tripData.transport.passes[idx]) return;
  const pass = tripData.transport.passes[idx];

  const safeName = escapeHtml(pass.name || "");
  const safeCost = escapeHtml(pass.cost || "");
  const safeCurr = escapeHtml(pass.currency || "日円");
  const safeNote = escapeHtml(pass.note || "");

  const formHtml = `
    <div class="ef-wrap">
      <div class="ef-label">周遊券 / 交通票券名稱 <span style="color:var(--red);">*</span></div>
      <input type="text" id="editPassName" class="ef-input" value="${safeName}" placeholder="例如: 關西廣域鐵路周遊券">
    </div>
    <div style="display:flex;gap:10px;">
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">票券費用 (純數字)</div>
        <input type="text" id="editPassCost" class="ef-input" value="${safeCost}" placeholder="例如: 17000">
      </div>
      <div class="ef-wrap" style="flex:1;">
        <div class="ef-label">幣別</div>
        <input type="text" id="editPassCurr" class="ef-input" value="${safeCurr}">
      </div>
    </div>
    <div class="ef-wrap">
      <div class="ef-label">備註說明 / 官方購票或兌換網址</div>
      <textarea id="editPassNote" class="ef-textarea" placeholder="例如: 兌換窗口或官方介紹網址">${safeNote}</textarea>
    </div>
  `;

  openFormModal({
    title: "✏️ 編輯周遊券 / 交通票券",
    bodyHtml: formHtml,
    confirmText: "儲存修改並同步",
    onConfirm: () => {
      const name = document.getElementById("editPassName").value.trim();
      const cost = document.getElementById("editPassCost").value.trim();
      const curr = document.getElementById("editPassCurr").value.trim() || "日円";
      const note = document.getElementById("editPassNote").value.trim();

      if (!name) {
        alert("請輸入票券名稱！");
        return false;
      }

      tripData.transport.passes[idx].name = name;
      tripData.transport.passes[idx].cost = cost;
      tripData.transport.passes[idx].currency = curr;
      tripData.transport.passes[idx].note = note;

      renderTransport();
      save();
      showToast("周遊券已更新 ✓");
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
