// =========================================================================
// Google Apps Script 後端程式碼
// 部署時請選擇：網頁應用程式 (Web App)
// 執行身分：我 (Me - 管理員的帳號)
// 誰有權限存取：任何人 (Anyone)
// =========================================================================

// 請貼上您在第一步建立的「主控試算表 (Master Sheet)」的 ID
const MASTER_SHEET_ID = "YOUR_MASTER_SHEET_ID_HERE";

// 請填寫您的 Google Client ID (用於防止 Token 偽造/跨應用替換)
const GOOGLE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID_HERE";

// 雲端硬碟總資料夾名稱（當建立新行程且未指定 ID 時，所有行程資料夾與手冊將自動歸檔於此路徑下）
const ROOT_TRAVEL_FOLDER_NAME = "my-travels";

// 輔助函式：取得或建立雲端硬碟根目錄下的指定資料夾 (加入防呆預設值)
function getOrCreateRootFolder(folderName) {
  const name = folderName || ROOT_TRAVEL_FOLDER_NAME || "my-travels";
  const folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(name);
}

// 輔助函式：標準化 Email（清除前後空白、不可見特殊字元、零寬空格與 BOM）
function normalizeEmail(email) {
  if (!email) return "";
  return email.toString().toLowerCase().replace(/[\u200B-\u200D\uFEFF\u00A0\s]/g, "");
}

// 輔助函式：安全解碼 JWT Payload（作為 Google Tokeninfo API 網路延遲或逾時時的強健備援）
function decodeJwtPayload(token) {
  try {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const decodedBytes = Utilities.base64DecodeWebSafe(parts[1]);
    const decodedString = Utilities.newBlob(decodedBytes).getDataAsString("UTF-8");
    return JSON.parse(decodedString);
  } catch (e) {
    return null;
  }
}

// 驗證前端傳過來的 Google ID Token (JWT)
// 透過 Google Tokeninfo API 安全解析出使用者的 Email，並驗證 Audience
function verifyIdToken(token) {
  if (!token) return null;
  
  // 1. 優先透過 Google 官方 Tokeninfo 端點進行在線驗證
  try {
    const url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token);
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() === 200) {
      const json = JSON.parse(response.getContentText());
      if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID !== "YOUR_GOOGLE_CLIENT_ID_HERE") {
        if (json.aud !== GOOGLE_CLIENT_ID) {
          Logger.log("安全性警示: Token aud 不匹配，拒絕存取");
          return null;
        }
      }
      if (json.email) {
        return normalizeEmail(json.email);
      }
    }
  } catch (e) {
    Logger.log("Tokeninfo 線上驗證異常: " + e.message);
  }

  // 2. 強健備援：若官方端點因暫時性網路抖動或微小過期拋錯，從 JWT 本地解碼驗證發行人與 Audience
  try {
    const payload = decodeJwtPayload(token);
    if (payload && payload.email) {
      const validIssuers = ["accounts.google.com", "https://accounts.google.com"];
      if (validIssuers.includes(payload.iss)) {
        if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID !== "YOUR_GOOGLE_CLIENT_ID_HERE") {
          if (payload.aud !== GOOGLE_CLIENT_ID) {
            return null;
          }
        }
        return normalizeEmail(payload.email);
      }
    }
  } catch (err) {
    Logger.log("Token 本地解析失敗: " + err.message);
  }

  return null;
}

// 取得使用者角色與可存取行程列表
function getUserAccess(email) {
  const masterSpreadsheet = SpreadsheetApp.openById(MASTER_SHEET_ID);
  const cleanEmail = normalizeEmail(email);
  
  let isAdmin = false;

  // A. 最高管理員保護：若使用者帳號與此 GAS 應用程式部署者/擁有者本人一致，100% 給予管理員權限
  try {
    const ownerEmail = normalizeEmail(Session.getEffectiveUser().getEmail());
    if (ownerEmail && cleanEmail && ownerEmail === cleanEmail) {
      isAdmin = true;
    }
  } catch (e) {
    Logger.log("檢查 EffectiveUser 異常: " + e.message);
  }

  // B. 容錯比對 Admins 管理員工作表
  if (!isAdmin && cleanEmail) {
    let adminSheet = masterSpreadsheet.getSheetByName("Admins");
    // 若工作表名稱大小寫或命名有些微差異，自動容錯相容
    if (!adminSheet) {
      const allSheets = masterSpreadsheet.getSheets();
      for (let s of allSheets) {
        const sName = s.getName().toLowerCase().replace(/[\s_]/g, "");
        if (sName === "admins" || sName === "admin" || sName === "管理員" || sName === "管理者") {
          adminSheet = s;
          break;
        }
      }
    }

    if (adminSheet) {
      const adminRows = adminSheet.getDataRange().getValues();
      for (let i = 0; i < adminRows.length; i++) {
        // 搜尋整列所有欄位，防止使用者將 Email 貼在第 B 欄或其他位置
        for (let col = 0; col < adminRows[i].length; col++) {
          const rowEmail = normalizeEmail(adminRows[i][col]);
          if (rowEmail && rowEmail === cleanEmail) {
            isAdmin = true;
            break;
          }
        }
        if (isAdmin) break;
      }
    }
  }
  
  // 2. 檢索可存取行程
  const tripSheet = masterSpreadsheet.getSheetByName("Trips");
  const tripRows = tripSheet.getDataRange().getValues();
  const allowedTrips = [];
  
  for (let i = 1; i < tripRows.length; i++) {
    const uuid = tripRows[i][0];
    const name = tripRows[i][1];
    const sheetId = tripRows[i][2];
    const folderId = tripRows[i][3];
    const allowedUsersStr = tripRows[i][4] || "";
    
    if (!uuid) continue;
    
    const password = tripRows[i][5] ? String(tripRows[i][5]).trim() : "";

    // 如果是管理員，可以看到所有行程
    // 如果是一般人，檢查其 Email 是否在 allowedUsersStr 清單內，或是公開行程
    if (isAdmin) {
      allowedTrips.push({ uuid: uuid, name: name, sheet_id: sheetId, folder_id: folderId, allowed_users: allowedUsersStr, password: password });
    } else {
      const allowedEmails = allowedUsersStr.toLowerCase().split(",").map(e => normalizeEmail(e));
      const isPublic = !allowedUsersStr || allowedEmails.includes("*") || allowedEmails.includes("public");
      if (isPublic || (cleanEmail && allowedEmails.includes(cleanEmail))) {
        allowedTrips.push({ uuid: uuid, name: name, password: password }); // 傳遞密碼資訊供前端解鎖校驗
      }
    }
  }
  
  return {
    role: isAdmin ? "admin" : (cleanEmail ? "user" : "guest"),
    trips: allowedTrips
  };
}

// 處理 GET 請求 (支援已登入管理員/團員，以及未登入訪客唯讀瀏覽)
function doGet(e) {
  const action = e.parameter.action;
  const authHeader = e.parameter.token || "";
  let token = authHeader;
  
  // 身份驗證 (未提供 token 或驗證失敗則為 guest 訪客)
  let email = null;
  if (token) {
    email = verifyIdToken(token);
  }
  
  let access = { role: "guest", trips: [] };
  const masterSpreadsheet = SpreadsheetApp.openById(MASTER_SHEET_ID);
  const tripSheet = masterSpreadsheet.getSheetByName("Trips");
  const tripRows = tripSheet.getDataRange().getValues();
  
  if (email) {
    access = getUserAccess(email);
  } else {
    // 訪客模式：僅讀取公開行程清單（隱蔽 Sheet & Folder ID）
    const publicTrips = [];
    for (let i = 1; i < tripRows.length; i++) {
      const uuid = tripRows[i][0];
      const name = tripRows[i][1];
      const allowedUsersStr = tripRows[i][4] || "";
      const allowedEmails = allowedUsersStr.toLowerCase().split(",").map(u => u.trim());
      const isPublic = !allowedUsersStr || allowedEmails.includes("*") || allowedEmails.includes("public");
      const password = tripRows[i][5] ? String(tripRows[i][5]).trim() : "";
      if (uuid && isPublic) {
        publicTrips.push({
          uuid: uuid,
          name: name,
          hasPassword: !!password,
          password: password // 供前端即時比對，後端亦進行實質雙重校驗
        });
      }
    }
    access = { role: "guest", trips: publicTrips };
  }
  
  if (action === "getTrips") {
    const responseData = {
      status: "success",
      role: access.role,
      trips: access.trips
    };
    return ContentService.createTextOutput(JSON.stringify(responseData))
                         .setMimeType(ContentService.MimeType.JSON);
  }
  
  if (action === "getTripData") {
    const tripUuid = e.parameter.tripUuid;
    let targetSheetId = "";
    let allowedUsersStr = "";
    let tripPassword = "";
    let tripName = "";
    
    // 搜尋對應的 Sheet ID、授權名單與專屬密碼
    for (let i = 1; i < tripRows.length; i++) {
      if (tripRows[i][0] === tripUuid) {
        tripName = tripRows[i][1];
        targetSheetId = tripRows[i][2];
        allowedUsersStr = tripRows[i][4] || "";
        tripPassword = tripRows[i][5] ? String(tripRows[i][5]).trim() : "";
        break;
      }
    }
    
    if (!targetSheetId) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "找不到該行程專屬試算表" }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
    
    // 權限檢查：若非管理員，檢查是否允許存取
    const allowedEmails = allowedUsersStr.toLowerCase().split(",").map(s => s.trim());
    const isPublic = !allowedUsersStr || allowedEmails.includes("*") || allowedEmails.includes("public");
    const isMember = email && allowedEmails.includes(email);
    const isAdmin = access.role === "admin";
    
    // 若該行程為私人專屬且目前訪客/使用者無權限
    if (!isPublic && !isMember && !isAdmin) {
      return ContentService.createTextOutput(JSON.stringify({ 
        status: "error", 
        message: "此行程為私人專屬手冊，請先登入已被授權的 Google 帳號。" 
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 關鍵資安門禁：若行程設有密碼且非管理員，後端嚴格校驗密碼，未通過絕不發送手冊數據！
    if (tripPassword && !isAdmin) {
      const clientPwd = String(e.parameter.tripPassword || e.parameter.password || "").trim();
      if (clientPwd !== tripPassword) {
        return ContentService.createTextOutput(JSON.stringify({
          status: "locked",
          uuid: tripUuid,
          name: tripName,
          hasPassword: true,
          message: "此旅程設有專屬密碼保護，請輸入密碼以解鎖手冊內容。"
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }
    
    // 讀取該旅遊專屬試算表的資料
    try {
      const data = loadTripDetails(targetSheetId);
      return ContentService.createTextOutput(JSON.stringify({ status: "success", role: access.role, data: data }))
                           .setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "讀取資料庫失敗: " + err.message }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
  }
  
  return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "無效的操作指令" }))
                       .setMimeType(ContentService.MimeType.JSON);
}

// 處理 POST 請求 (建立、修改、上傳)
function doPost(e) {
  const postData = JSON.parse(e.postData.contents);
  const action = postData.action;
  
  // 取得 Authorization Token
  // 處理 headers 驗證
  // 由於 Google Web App 的限制，通常我們在 postData 中將 token 一併帶上，或在 headers 解析
  
  // 實作上以 client 發送的 JSON postData 中的 token 或手動驗證
  // 這裡假設驗證方式同 doGet
  
  // 安全性防禦：檢查呼叫者權限
  // 我們讓前端在 body 中附帶 token 進行驗證
  const token = postData.token;
  const email = verifyIdToken(token);
  if (!email) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Unauthorized" }))
                         .setMimeType(ContentService.MimeType.JSON);
  }
  
  const access = getUserAccess(email);
  
  // 只有管理員可以執行 POST 修改動作
  if (access.role !== "admin") {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Admin privileges required" }))
                         .setMimeType(ContentService.MimeType.JSON);
  }
  
  const masterSpreadsheet = SpreadsheetApp.openById(MASTER_SHEET_ID);
  
  // 1. 建立新行程與初始化 (支援自動建立 Google 雲端硬碟資料夾與試算表)
  if (action === "createTrip") {
    const uuid = postData.uuid;
    const name = postData.name;
    let sheetId = (postData.sheetId || "").trim();
    let folderId = (postData.folderId || "").trim();
    const allowedUsers = postData.allowedUsers || "";
    const startDate = postData.startDate || "";
    const endDate = postData.endDate || "";
    const duration = postData.duration || "";
    
    // 若 sheetId 或 folderId 為空，啟動全自動建立機制
    if (!sheetId || !folderId) {
      try {
        // 1. 取得或建立總目錄 my-travels
        const rootFolder = getOrCreateRootFolder(ROOT_TRAVEL_FOLDER_NAME);
        
        // 2. 在 my-travels 底下為該行程建立專屬主資料夾
        const tripFolder = rootFolder.createFolder(name);
        
        // 3. 若 folderId 為空，在行程資料夾內建立「景點照片與上傳檔案」相簿資料夾
        if (!folderId) {
          const photoFolder = tripFolder.createFolder("景點照片與上傳檔案");
          // 設定共享權限為「任何知道連結的人均可檢視」，避免圖片讀取 403
          photoFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          folderId = photoFolder.getId();
        }
        
        // 4. 若 sheetId 為空，在行程資料夾內建立專屬試算表
        if (!sheetId) {
          const newSS = SpreadsheetApp.create(name + " - 行程手冊");
          sheetId = newSS.getId();
          
          // 將建立於根目錄的試算表檔案移入 tripFolder
          const file = DriveApp.getFileById(sheetId);
          tripFolder.addFile(file);
          DriveApp.getRootFolder().removeFile(file);
        }
      } catch (driveErr) {
        return ContentService.createTextOutput(JSON.stringify({
          status: "error",
          message: "自動在雲端硬碟建立資料夾或試算表失敗: " + driveErr.message
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }
    
    const password = (postData.password || "").trim();
    
    const tripSheet = masterSpreadsheet.getSheetByName("Trips");
    tripSheet.appendRow([uuid, name, sheetId, folderId, allowedUsers, password]);
    
    // 初始化關聯試算表的結構與分頁
    try {
      initializeSubSheet(sheetId, name, startDate, endDate, duration, password);
      return ContentService.createTextOutput(JSON.stringify({ 
        status: "success", 
        sheetId: sheetId,
        folderId: folderId,
        message: "行程建立成功！已自動在雲端硬碟「" + ROOT_TRAVEL_FOLDER_NAME + "/" + name + "」建立專屬資料夾與試算表手冊。" 
      })).setMimeType(ContentService.MimeType.JSON);
    } catch(err) {
      return ContentService.createTextOutput(JSON.stringify({ 
        status: "error", 
        message: "試算表初始化失敗: " + err.message 
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }
  
  // 2. 儲存/更新行程詳細旅遊資料
  if (action === "updateTripData") {
    const tripUuid = postData.tripUuid;
    const data = postData.data;
    
    // 找出對應的 Sheet ID
    const tripSheet = masterSpreadsheet.getSheetByName("Trips");
    const tripRows = tripSheet.getDataRange().getValues();
    let targetSheetId = "";
    for (let i = 1; i < tripRows.length; i++) {
      if (tripRows[i][0] === tripUuid) {
        targetSheetId = tripRows[i][2];
        break;
      }
    }
    
    if (targetSheetId) {
      saveTripDetails(targetSheetId, data);
      return ContentService.createTextOutput(JSON.stringify({ status: "success", message: "Cloud sync success" }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // 3. 修改行程基本設定（名稱、出發/結束日期、天數、授權名單）
  if (action === "updateTripMeta") {
    const tripUuid = postData.tripUuid;
    const name = postData.name;
    const startDate = postData.startDate;
    const endDate = postData.endDate;
    const duration = postData.duration;
    const allowedUsers = postData.allowedUsers || "";
    const password = postData.password !== undefined ? String(postData.password).trim() : null;
    
    const tripSheet = masterSpreadsheet.getSheetByName("Trips");
    const tripRows = tripSheet.getDataRange().getValues();
    let targetSheetId = "";
    let targetRowIndex = -1;
    for (let i = 1; i < tripRows.length; i++) {
      if (tripRows[i][0] === tripUuid) {
        targetSheetId = tripRows[i][2];
        targetRowIndex = i + 1; // 1-based index
        break;
      }
    }
    
    if (targetRowIndex !== -1 && targetSheetId) {
      // 1. 更新主控表 Trips 分頁 (名稱、授權清單與密碼)
      tripSheet.getRange(targetRowIndex, 2).setValue(name);
      tripSheet.getRange(targetRowIndex, 5).setValue(allowedUsers);
      if (password !== null) {
        tripSheet.getRange(targetRowIndex, 6).setValue(password);
      }
      
      // 2. 更新個別試算表 Info 分頁
      try {
        const subSs = SpreadsheetApp.openById(targetSheetId);
        const infoSheet = subSs.getSheetByName("Info");
        if (infoSheet) {
          infoSheet.getRange(2, 2).setValue(name);
          infoSheet.getRange(3, 2).setValue(startDate);
          infoSheet.getRange(4, 2).setValue(endDate);
          infoSheet.getRange(5, 2).setValue(duration);
          if (password !== null) {
            let hasPwdRow = false;
            const infoData = infoSheet.getDataRange().getValues();
            for (let r = 0; r < infoData.length; r++) {
              if (String(infoData[r][0]).toLowerCase() === "password") {
                infoSheet.getRange(r + 1, 2).setValue(password);
                hasPwdRow = true;
                break;
              }
            }
            if (!hasPwdRow) {
              infoSheet.appendRow(["Password", password]);
            }
          }
        }
        return ContentService.createTextOutput(JSON.stringify({ status: "success", message: "Trip meta updated successfully" }))
                             .setMimeType(ContentService.MimeType.JSON);
      } catch (err) {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Failed to update sub sheet: " + err.message }))
                             .setMimeType(ContentService.MimeType.JSON);
      }
    } else {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Trip not found" }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
  }
  
  // 4. 上傳圖片到該行程的雲端硬碟
  if (action === "uploadImage") {
    const tripUuid = postData.tripUuid;
    const filename = postData.filename;
    const mimeType = postData.mimeType;
    const base64Data = postData.data;
    
    // 找出該行程的 Folder ID
    const tripSheet = masterSpreadsheet.getSheetByName("Trips");
    const tripRows = tripSheet.getDataRange().getValues();
    let folderId = "";
    for (let i = 1; i < tripRows.length; i++) {
      if (tripRows[i][0] === tripUuid) {
        folderId = tripRows[i][3];
        break;
      }
    }
    
    if (folderId) {
      try {
        const folder = DriveApp.getFolderById(folderId);
        const decoded = Utilities.base64Decode(base64Data);
        const blob = Utilities.newBlob(decoded, mimeType, filename);
        const file = folder.createFile(blob);
        
        // 設定共用權限為「任何知道連結的人皆可檢視」，以供網頁直接渲染
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        const fileId = file.getId();
        // 轉換為直連預覽網址（使用 lh3.googleusercontent.com 避免 uc?export=view 被 Google 阻擋 403）
        const previewUrl = "https://lh3.googleusercontent.com/d/" + fileId;
        
        return ContentService.createTextOutput(JSON.stringify({ status: "success", url: previewUrl }))
                             .setMimeType(ContentService.MimeType.JSON);
      } catch (err) {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Drive upload failed: " + err.message }))
                             .setMimeType(ContentService.MimeType.JSON);
      }
    }
  }
  
  return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Action handler not found" }))
                       .setMimeType(ContentService.MimeType.JSON);
}

// 初始化關聯試算表結構
function initializeSubSheet(sheetId, tripName, startDate, endDate, duration, password) {
  const ss = SpreadsheetApp.openById(sheetId);
  
  // 1. 基本資訊頁 (Info)
  let infoSheet = ss.getSheetByName("Info");
  if (!infoSheet) infoSheet = ss.insertSheet("Info");
  infoSheet.clear();
  infoSheet.appendRow(["Key", "Value"]);
  infoSheet.appendRow(["Name", tripName || "旅遊手冊"]);
  infoSheet.appendRow(["StartDate", startDate || "2027-02-12"]);
  infoSheet.appendRow(["EndDate", endDate || "2027-02-19"]);
  infoSheet.appendRow(["Duration", duration || "8天7夜"]);
  infoSheet.appendRow(["Password", password || ""]);
  
  // 2. 準備清單頁 (Checklist)
  let checklistSheet = ss.getSheetByName("Checklist");
  if (!checklistSheet) checklistSheet = ss.insertSheet("Checklist");
  checklistSheet.clear();
  checklistSheet.appendRow(["id", "cat", "title", "note", "link", "done"]);
  checklistSheet.appendRow(["1", "證件", "護照與簽證", "出發前檢查效期需大於6個月", "", "FALSE"]);
  
  // 3. 航班與住宿 (Flights)
  let flightsSheet = ss.getSheetByName("Flights");
  if (!flightsSheet) flightsSheet = ss.insertSheet("Flights");
  flightsSheet.clear();
  flightsSheet.appendRow(["Type", "airline", "no", "from", "to", "date", "dep", "arr", "note"]);
  flightsSheet.appendRow(["out", "虎航", "IT214", "TPE桃園", "OKJ岡山", "2027-02-12", "11:30", "15:05", "準時登機"]);
  flightsSheet.appendRow(["in", "虎航", "IT215", "OKJ岡山", "TPE桃園", "2027-02-19", "15:55", "17:40", ""]);
  
  // 4. 飯店資訊 (Hotel)
  let hotelSheet = ss.getSheetByName("Hotel");
  if (!hotelSheet) hotelSheet = ss.insertSheet("Hotel");
  hotelSheet.clear();
  hotelSheet.appendRow(["name", "addr", "checkin", "checkout", "nights", "note"]);
  hotelSheet.appendRow(["岡山格蘭比亞大酒店", "〒700-0024 岡山県岡山市北区駅元町1-5", "2027-02-12", "2027-02-19", "7晚", "岡山站直結，出站即達"]);
  
  // 5. 行程規劃 (Days)
  let daysSheet = ss.getSheetByName("Days");
  if (!daysSheet) daysSheet = ss.insertSheet("Days");
  daysSheet.clear();
  daysSheet.appendRow(["dayId", "date", "title", "time", "place", "desc", "imgUrl", "link"]);
  daysSheet.appendRow(["Day 1", "2月12日（五）", "岡山空港 ➔ 岡山車站", "15:30", "岡山桃太郎空港", "搭乘接駁巴士前往市區", "", ""]);
  
  // 6. 美食清單 (Food)
  let foodSheet = ss.getSheetByName("Food");
  if (!foodSheet) foodSheet = ss.insertSheet("Food");
  foodSheet.clear();
  foodSheet.appendRow(["id", "emoji", "name", "area", "desc", "must", "done", "imgUrl"]);
  foodSheet.appendRow(["f1", "🦪", "日生 牡蠣燒 (お好み焼き)", "日生町", "岡山限定冬季美味", "TRUE", "FALSE", ""]);
  
  // 7. 代購清單 (Shopping)
  let shoppingSheet = ss.getSheetByName("Shopping");
  if (!shoppingSheet) shoppingSheet = ss.insertSheet("Shopping");
  shoppingSheet.clear();
  shoppingSheet.appendRow(["id", "buyer", "name", "location", "price", "qty", "link", "imgUrl", "note", "done"]);
  shoppingSheet.appendRow(["s1", "媽媽", "合利他命 EX Plus 270錠", "BicCamera 岡山站前店", "¥5,800", "2瓶", "https://www.biccamera.com/", "", "買2瓶，注意效期", "FALSE"]);

  // 8. 交通規劃 (交通 / Transport)
  let transSheet = ss.getSheetByName("交通");
  if (!transSheet) transSheet = ss.insertSheet("交通");
  transSheet.clear();
  transSheet.appendRow(["日期", "行程", "起訖點/內容", "時間", "預估費用/人", "幣別", "車種資訊", "備註"]);
  transSheet.appendRow(["", "黑部立山周遊券", "", "", "24000", "日円", "", ""]);
  transSheet.appendRow(["D1-8/5", "中部機場到名古屋", "", "14:30", "980", "日円", "指定席450円", "第1月台"]);
  transSheet.appendRow(["D1-8/5", "名古屋到高山", "下午 4:03:00 Hida 15", "16:03", "", "", "使用周遊券(劃位)", ""]);
}

// 輔助函式：將試算表可能自動轉為 Date 物件的時間格式過濾回乾淨字串 (例如 "14:00")
function formatTimeString(val) {
  if (val === null || val === undefined) return "";
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), "HH:mm");
  }
  const str = val.toString().trim();
  // 匹配 Sat Dec 30 1899 14:00:00 或 ISO 格式
  if (str.includes("1899") || str.includes("1900") || (str.includes("T") && str.includes("Z"))) {
    const m = str.match(/(\d{1,2}:\d{2})(?::\d{2})?/);
    if (m) return m[1];
    try {
      const d = new Date(str);
      if (!isNaN(d.getTime())) {
        return Utilities.formatDate(d, Session.getScriptTimeZone(), "HH:mm");
      }
    } catch (e) {}
  }
  return str;
}

// 從個別試算表加載完整 JSON 資料
function loadTripDetails(sheetId) {
  const ss = SpreadsheetApp.openById(sheetId);
  const result = {};
  
  // 1. Info
  const infoRows = ss.getSheetByName("Info").getDataRange().getDisplayValues();
  result.name = infoRows[1][1];
  result.startDate = infoRows[2][1];
  result.endDate = infoRows[3][1];
  result.duration = infoRows[4][1];
  for (let r = 1; r < infoRows.length; r++) {
    if (String(infoRows[r][0]).toLowerCase() === "password") {
      result.password = infoRows[r][1];
      break;
    }
  }
  
  // 2. Checklist
  result.checklist = [];
  const chRows = ss.getSheetByName("Checklist").getDataRange().getDisplayValues();
  for (let i = 1; i < chRows.length; i++) {
    result.checklist.push({
      id: chRows[i][0],
      cat: chRows[i][1],
      title: chRows[i][2],
      note: chRows[i][3],
      link: chRows[i][4],
      done: chRows[i][5].toString().toUpperCase() === "TRUE"
    });
  }
  
  // 3. Flights
  result.flights = { out: {}, in: {} };
  const flRows = ss.getSheetByName("Flights").getDataRange().getDisplayValues();
  for (let i = 1; i < flRows.length; i++) {
    const type = flRows[i][0];
    const data = {
      airline: flRows[i][1],
      no: flRows[i][2],
      from: flRows[i][3],
      to: flRows[i][4],
      date: flRows[i][5],
      dep: formatTimeString(flRows[i][6]),
      arr: formatTimeString(flRows[i][7]),
      note: flRows[i][8]
    };
    if (type === "out") result.flights.out = data;
    if (type === "in") result.flights.in = data;
  }
  
  // 4. Hotel (支援多筆飯店住宿)
  result.hotels = [];
  const hoRows = ss.getSheetByName("Hotel").getDataRange().getDisplayValues();
  for (let i = 1; i < hoRows.length; i++) {
    if (!hoRows[i][0] && !hoRows[i][1]) continue;
    result.hotels.push({
      id: "h" + i,
      name: hoRows[i][0],
      addr: hoRows[i][1],
      checkin: hoRows[i][2] || "",
      checkout: hoRows[i][3] || "",
      nights: hoRows[i][4],
      note: hoRows[i][5]
    });
  }
  // 向下相容單筆物件
  result.hotel = result.hotels.length > 0 ? result.hotels[0] : {};
  
  // 5. Days (使用 getDisplayValues 直接讀取純文字，包含 link 欄位)
  result.days = [];
  const dyRows = ss.getSheetByName("Days").getDataRange().getDisplayValues();
  const dayMap = {};
  for (let i = 1; i < dyRows.length; i++) {
    const dayId = dyRows[i][0];
    const date = dyRows[i][1];
    const dayTitle = dyRows[i][2];
    const time = formatTimeString(dyRows[i][3]);
    const place = dyRows[i][4];
    const desc = dyRows[i][5];
    const imgUrl = dyRows[i][6];
    const link = dyRows[i][7] || "";
    
    if (!dayMap[dayId]) {
      dayMap[dayId] = {
        id: dayId,
        date: date,
        title: dayTitle,
        items: []
      };
      result.days.push(dayMap[dayId]);
    }
    
    if (place) {
      dayMap[dayId].items.push({
        time: time,
        place: place,
        desc: desc,
        imgUrl: imgUrl,
        link: link
      });
    }
  }
  
  // 6. Food (美食口袋清單，支援圖片與地圖)
  result.food = [];
  const fdSheet = ss.getSheetByName("Food");
  if (fdSheet) {
    const fdRows = fdSheet.getDataRange().getValues();
    for (let i = 1; i < fdRows.length; i++) {
      if (!fdRows[i][0] && !fdRows[i][2]) continue;
      result.food.push({
        id: fdRows[i][0],
        emoji: fdRows[i][1] || "🍴",
        name: fdRows[i][2] || "",
        area: fdRows[i][3] || "",
        desc: fdRows[i][4] || "",
        must: (fdRows[i][5] || "").toString().toUpperCase() === "TRUE",
        done: (fdRows[i][6] || "").toString().toUpperCase() === "TRUE",
        imgUrl: fdRows[i][7] || ""
      });
    }
  }
  
  // 7. Shopping (代購清單)
  result.shopping = [];
  const shSheet = ss.getSheetByName("Shopping");
  if (shSheet) {
    const shRows = shSheet.getDataRange().getDisplayValues();
    if (shRows.length > 0) {
      const headers = shRows[0].map(h => h.toString().trim().toLowerCase());
      const qtyIdx = headers.indexOf("qty");
      const hasQtyCol = qtyIdx !== -1;
      
      for (let i = 1; i < shRows.length; i++) {
        if (!shRows[i][0] && !shRows[i][2]) continue;
        if (hasQtyCol) {
          result.shopping.push({
            id: shRows[i][0] || ("s" + i),
            buyer: shRows[i][1] || "自己",
            name: shRows[i][2] || "",
            location: shRows[i][3] || "",
            price: shRows[i][4] || "",
            qty: shRows[i][5] || "1",
            link: shRows[i][6] || "",
            imgUrl: shRows[i][7] || "",
            note: shRows[i][8] || "",
            done: (shRows[i][9] || "").toString().toUpperCase() === "TRUE"
          });
        } else {
          result.shopping.push({
            id: shRows[i][0] || ("s" + i),
            buyer: shRows[i][1] || "自己",
            name: shRows[i][2] || "",
            location: shRows[i][3] || "",
            price: shRows[i][4] || "",
            qty: "1",
            link: shRows[i][5] || "",
            imgUrl: shRows[i][6] || "",
            note: shRows[i][7] || "",
            done: (shRows[i][8] || "").toString().toUpperCase() === "TRUE"
          });
        }
      }
    }
  }

  // 8. 交通 (Transport) - 多張路線地圖相簿、周遊券與乘車行程
  result.transport = { maps: [], passes: [], routes: [], mapImgUrl: "", mapNote: "" };
  const transSheet = ss.getSheetByName("交通") || ss.getSheetByName("Transport");
  if (transSheet) {
    const trRows = transSheet.getDataRange().getDisplayValues();
    if (trRows.length > 0) {
      for (let i = 1; i < trRows.length; i++) {
        const colA = (trRows[i][0] || "").toString().trim();
        const colB = (trRows[i][1] || "").toString().trim();
        const colC = (trRows[i][2] || "").toString().trim();
        const colD = formatTimeString(trRows[i][3]);
        const colE = (trRows[i][4] || "").toString().trim();
        const colF = (trRows[i][5] || "日円").toString().trim();
        const colG = (trRows[i][6] || "").toString().trim();
        const colH = (trRows[i][7] || "").toString().trim();

        if (!colA && !colB) continue;

        // 若 A 欄為「地圖」或「MAP」，則讀取為路線地圖相簿項目
        if (colA === "地圖" || colA === "MAP" || colA.toLowerCase() === "map") {
          const mapTitle = colC || `路線圖 ${result.transport.maps.length + 1}`;
          const mapUrl = colB;
          const mapNote = colH || colC || "";
          result.transport.maps.push({
            id: "map_" + i,
            title: mapTitle,
            url: mapUrl,
            note: mapNote
          });
          if (!result.transport.mapImgUrl) {
            result.transport.mapImgUrl = mapUrl;
            result.transport.mapNote = mapTitle;
          }
          continue;
        }

        // 若 B 欄包含「周遊券」或「PASS」且 A 欄為空或標籤，讀為周遊券
        if (colB.includes("周遊券") || colB.includes("PASS") || colB.includes("Pass") || colA === "周遊券") {
          result.transport.passes.push({
            id: "p" + i,
            name: colB,
            cost: colE,
            currency: colF,
            note: colH || colC
          });
          continue;
        }

        // 一般乘車行程
        result.transport.routes.push({
          id: "t" + i,
          dayTag: colA || "主要交通",
          fromTo: colB,
          time: colD || colC,
          cost: colE,
          currency: colF,
          trainInfo: colG || colC,
          seatInfo: colG,
          note: colH
        });
      }
    }
  }
  
  return result;
}

// 儲存前端修改後的完整資料回 Google 試算表
function saveTripDetails(sheetId, data) {
  const ss = SpreadsheetApp.openById(sheetId);
  
  // 1. Info
  const infoSheet = ss.getSheetByName("Info");
  if (infoSheet) {
    infoSheet.getRange(2, 2).setValue(data.name);
    infoSheet.getRange(3, 2).setValue(data.startDate);
    infoSheet.getRange(4, 2).setValue(data.endDate);
    infoSheet.getRange(5, 2).setValue(data.duration);
  }
  
  // 2. Checklist
  const checklistSheet = ss.getSheetByName("Checklist");
  if (checklistSheet) {
    checklistSheet.clearContents();
    checklistSheet.appendRow(["id", "cat", "title", "note", "link", "done"]);
    (data.checklist || []).forEach(item => {
      checklistSheet.appendRow([item.id, item.cat, item.title, item.note, item.link, item.done ? "TRUE" : "FALSE"]);
    });
  }
  
  // 3. Flights
  const flightsSheet = ss.getSheetByName("Flights");
  if (flightsSheet) {
    flightsSheet.clearContents();
    flightsSheet.appendRow(["Type", "airline", "no", "from", "to", "date", "dep", "arr", "note"]);
    if (data.flights && data.flights.out) {
      const f = data.flights.out;
      flightsSheet.appendRow(["out", f.airline, f.no, f.from, f.to, f.date, f.dep, f.arr, f.note]);
    }
    if (data.flights && data.flights.in) {
      const f = data.flights.in;
      flightsSheet.appendRow(["in", f.airline, f.no, f.from, f.to, f.date, f.dep, f.arr, f.note]);
    }
  }
  
  // 4. Hotel (支援多筆飯店住宿)
  const hotelSheet = ss.getSheetByName("Hotel");
  if (hotelSheet) {
    hotelSheet.clearContents();
    hotelSheet.appendRow(["name", "addr", "checkin", "checkout", "nights", "note"]);
    const hotelList = data.hotels || (data.hotel ? [data.hotel] : []);
    hotelList.forEach(h => {
      if (h.name || h.addr) {
        hotelSheet.appendRow([h.name || "", h.addr || "", h.checkin || "", h.checkout || "", h.nights || "", h.note || ""]);
      }
    });
  }
  
  // 5. Days
  const daysSheet = ss.getSheetByName("Days");
  if (daysSheet) {
    daysSheet.clearContents();
    daysSheet.appendRow(["dayId", "date", "title", "time", "place", "desc", "imgUrl", "link"]);
    (data.days || []).forEach(d => {
      if (d.items && d.items.length > 0) {
        d.items.forEach(item => {
          daysSheet.appendRow([d.id, d.date, d.title, item.time, item.place, item.desc, item.imgUrl || "", item.link || ""]);
        });
      } else {
        daysSheet.appendRow([d.id, d.date, d.title, "", "", "", "", ""]);
      }
    });
  }
  
  // 6. Food (美食口袋清單，支援圖片與地圖)
  let foodSheet = ss.getSheetByName("Food");
  if (!foodSheet) foodSheet = ss.insertSheet("Food");
  foodSheet.clearContents();
  foodSheet.appendRow(["id", "emoji", "name", "area", "desc", "must", "done", "imgUrl"]);
  (data.food || []).forEach(item => {
    foodSheet.appendRow([
      item.id || "",
      item.emoji || "🍴",
      item.name || "",
      item.area || "",
      item.desc || "",
      item.must ? "TRUE" : "FALSE",
      item.done ? "TRUE" : "FALSE",
      item.imgUrl || ""
    ]);
  });

  // 7. Shopping (代購清單)
  let shoppingSheet = ss.getSheetByName("Shopping");
  if (!shoppingSheet) shoppingSheet = ss.insertSheet("Shopping");
  shoppingSheet.clearContents();
  shoppingSheet.appendRow(["id", "buyer", "name", "location", "price", "qty", "link", "imgUrl", "note", "done"]);
  (data.shopping || []).forEach(item => {
    shoppingSheet.appendRow([
      item.id || "",
      item.buyer || "",
      item.name || "",
      item.location || "",
      item.price || "",
      item.qty || "1",
      item.link || "",
      item.imgUrl || "",
      item.note || "",
      item.done ? "TRUE" : "FALSE"
    ]);
  });

  // 8. 交通 (Transport)
  if (data.transport) {
    let transSheet = ss.getSheetByName("交通") || ss.getSheetByName("Transport");
    if (!transSheet) transSheet = ss.insertSheet("交通");
    transSheet.clearContents();
    transSheet.appendRow(["類別/日期", "圖片網址/行程", "名稱/起訖點", "時間", "預估費用/人", "幣別", "車種/座位", "備註"]);

    // 寫入多張地圖相簿資訊
    const maps = data.transport.maps || [];
    if (maps.length > 0) {
      maps.forEach(m => {
        if (m.url) {
          transSheet.appendRow(["地圖", m.url, m.title || "路線地圖", "", "", "", "", m.note || ""]);
        }
      });
    } else if (data.transport.mapImgUrl) {
      // 向下相容單張地圖
      transSheet.appendRow(["地圖", data.transport.mapImgUrl, data.transport.mapNote || "主要交通路線圖", "", "", "", "", data.transport.mapNote || ""]);
    }

    // 寫入周遊券
    (data.transport.passes || []).forEach(p => {
      transSheet.appendRow(["周遊券", p.name, "", "", p.cost || "", p.currency || "日円", "", p.note || ""]);
    });

    // 寫入乘車行程
    (data.transport.routes || []).forEach(r => {
      transSheet.appendRow([
        r.dayTag || "",
        r.fromTo || "",
        r.trainInfo || "",
        r.time || "",
        r.cost || "",
        r.currency || "日円",
        r.seatInfo || "",
        r.note || ""
      ]);
    });
  }
}

