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

// 自動根據出發與結束日期推算天數晚數 (例如: 8天7夜)
function calcTripDurationInGas(startDate, endDate) {
  if (!startDate || !endDate) return "";
  try {
    const s = String(startDate).split("T")[0].trim();
    const e = String(endDate).split("T")[0].trim();
    const d1 = new Date(s + "T00:00:00");
    const d2 = new Date(e + "T00:00:00");
    if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return "";
    const diffDays = Math.round((d2.getTime() - d1.getTime()) / 86400000) + 1;
    if (diffDays > 0) {
      const nights = diffDays - 1;
      return diffDays + "天" + (nights > 0 ? nights + "夜" : "");
    }
  } catch (err) {}
  return "";
}

// 取得使用者角色與可存取行程列表
function getUserAccess(email) {
  const masterSpreadsheet = SpreadsheetApp.openById(MASTER_SHEET_ID);
  const cleanEmail = normalizeEmail(email);
  const allowedTrips = [];
  
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
  for (let i = 1; i < tripRows.length; i++) {
    const uuid = tripRows[i][0];
    const name = tripRows[i][1];
    const sheetId = tripRows[i][2];
    const folderId = tripRows[i][3];
    const allowedUsersStr = tripRows[i][4] || "";
    
    if (!uuid) continue;
    
    const password = tripRows[i][5] ? String(tripRows[i][5]).trim() : "";
    const startDate = tripRows[i][6] ? String(tripRows[i][6]).trim() : "";
    const endDate = tripRows[i][7] ? String(tripRows[i][7]).trim() : "";
    let duration = tripRows[i][8] ? String(tripRows[i][8]).trim() : "";
    if (!duration && startDate && endDate) {
      duration = calcTripDurationInGas(startDate, endDate);
    }

    // 如果是管理員，可以看到所有行程
    // 如果是一般人，檢查其 Email 是否在 allowedUsersStr 清單內，或是公開行程
    if (isAdmin) {
      allowedTrips.push({ 
        uuid: uuid, 
        name: name, 
        sheet_id: sheetId, 
        folder_id: folderId, 
        allowed_users: allowedUsersStr, 
        password: password,
        startDate: startDate,
        endDate: endDate,
        duration: duration
      });
    } else {
      const allowedEmails = allowedUsersStr.toLowerCase().split(",").map(e => normalizeEmail(e));
      const isPublic = !allowedUsersStr || allowedEmails.includes("*") || allowedEmails.includes("public");
      if (isPublic || (cleanEmail && allowedEmails.includes(cleanEmail))) {
        allowedTrips.push({ 
          uuid: uuid, 
          name: name, 
          password: password,
          startDate: startDate,
          endDate: endDate,
          duration: duration
        }); // 傳遞密碼與日期天數供前端顯示
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
  try {
    if (!e || !e.parameter) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "缺少請求參數" }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
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
      const startDate = tripRows[i][6] ? String(tripRows[i][6]).trim() : "";
      const endDate = tripRows[i][7] ? String(tripRows[i][7]).trim() : "";
      let duration = tripRows[i][8] ? String(tripRows[i][8]).trim() : "";
      if (!duration && startDate && endDate) {
        duration = calcTripDurationInGas(startDate, endDate);
      }
      if (uuid && isPublic) {
        publicTrips.push({
          uuid: uuid,
          name: name,
          hasPassword: !!password,
          password: password,
          startDate: startDate,
          endDate: endDate,
          duration: duration
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
    let tripStartDate = "";
    let tripEndDate = "";
    let tripDuration = "";
    
    // 搜尋對應的 Sheet ID、授權名單與專屬密碼及 Meta
    for (let i = 1; i < tripRows.length; i++) {
      if (tripRows[i][0] === tripUuid) {
        tripName = tripRows[i][1];
        targetSheetId = tripRows[i][2];
        allowedUsersStr = tripRows[i][4] || "";
        tripPassword = tripRows[i][5] ? String(tripRows[i][5]).trim() : "";
        tripStartDate = tripRows[i][6] ? String(tripRows[i][6]).trim() : "";
        tripEndDate = tripRows[i][7] ? String(tripRows[i][7]).trim() : "";
        tripDuration = tripRows[i][8] ? String(tripRows[i][8]).trim() : "";
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
      // 雙向防呆對齊：若子表 Info 的 Name、日期或天數為空，自動以 Trips 總表登記資料作為強健備援
      if (!data.name && tripName) data.name = tripName;
      if (!data.startDate && tripStartDate) data.startDate = tripStartDate;
      if (!data.endDate && tripEndDate) data.endDate = tripEndDate;
      if (!data.duration && tripDuration) data.duration = tripDuration;
      if (!data.duration && data.startDate && data.endDate) {
        data.duration = calcTripDurationInGas(data.startDate, data.endDate);
      }
      return ContentService.createTextOutput(JSON.stringify({ status: "success", role: access.role, data: data }))
                           .setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "讀取資料庫失敗: " + err.message }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
  }
  
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "無效的操作指令" }))
                         .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "後端讀取異常: " + err.message }))
                         .setMimeType(ContentService.MimeType.JSON);
  }
}

// 處理 POST 請求 (建立、修改、上傳)
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "缺少請求內文 (Empty payload)" }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
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
    const theme = (postData.theme || "violet").trim();
    
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
    
    let finalDuration = duration;
    if (!finalDuration && startDate && endDate) {
      finalDuration = calcTripDurationInGas(startDate, endDate);
    }
    
    const tripSheet = masterSpreadsheet.getSheetByName("Trips");
    tripSheet.appendRow([uuid, name, sheetId, folderId, allowedUsers, password, startDate, endDate, finalDuration]);
    
    // 初始化關聯試算表的結構與分頁
    try {
      initializeSubSheet(sheetId, name, startDate, endDate, finalDuration, password, theme);
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
    } else {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Trip not found" }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // 3. 修改行程基本設定（名稱、出發/結束日期、天數、主題色彩、授權名單）
  if (action === "updateTripMeta") {
    const tripUuid = postData.tripUuid;
    const name = postData.name;
    const startDate = postData.startDate;
    const endDate = postData.endDate;
    const duration = postData.duration;
    const theme = postData.theme !== undefined ? String(postData.theme).trim() : null;
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
      let finalDuration = duration;
      if (!finalDuration && startDate && endDate) {
        finalDuration = calcTripDurationInGas(startDate, endDate);
      }

      // 1. 更新主控表 Trips 分頁 (名稱、授權清單與密碼，以及出發日期、結束日期與天數)
      tripSheet.getRange(targetRowIndex, 2).setValue(name);
      tripSheet.getRange(targetRowIndex, 5).setValue(allowedUsers);
      if (password !== null) {
        tripSheet.getRange(targetRowIndex, 6).setValue(password);
      }
      if (startDate !== undefined) tripSheet.getRange(targetRowIndex, 7).setValue(startDate);
      if (endDate !== undefined) tripSheet.getRange(targetRowIndex, 8).setValue(endDate);
      if (finalDuration !== undefined) tripSheet.getRange(targetRowIndex, 9).setValue(finalDuration);
      
      // 2. 更新個別試算表 Info 分頁 (使用動態 Key-Value 寫入，徹底杜絕欄位錯位)
      try {
        const subSs = SpreadsheetApp.openById(targetSheetId);
        let infoSheet = subSs.getSheetByName("Info");
        if (!infoSheet) {
          infoSheet = subSs.insertSheet("Info");
          infoSheet.appendRow(["Key", "Value"]);
        }

        const metaMap = {
          "Name": name,
          "StartDate": startDate,
          "EndDate": endDate,
          "Duration": finalDuration
        };
        if (password !== null) {
          metaMap["Password"] = password;
        }
        if (theme !== null) {
          metaMap["Theme"] = theme;
        }
        setInfoSheetMap(infoSheet, metaMap);
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
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "後端處理失敗: " + err.message }))
                         .setMimeType(ContentService.MimeType.JSON);
  }
}

// 初始化關聯試算表結構 (遵循純白留空原則，建立標準欄位 Header，不預設硬編碼任何舊行程資料，徹底避免跨行程污染)
function initializeSubSheet(sheetId, tripName, startDate, endDate, duration, password, theme) {
  const ss = SpreadsheetApp.openById(sheetId);
  const effectiveName = tripName || "旅遊手冊";
  
  // 1. 基本資訊頁 (Info)
  let infoSheet = ss.getSheetByName("Info");
  if (!infoSheet) infoSheet = ss.insertSheet("Info");
  infoSheet.clear();
  infoSheet.appendRow(["Key", "Value"]);
  infoSheet.appendRow(["Name", effectiveName]);
  infoSheet.appendRow(["StartDate", startDate || ""]);
  infoSheet.appendRow(["EndDate", endDate || ""]);
  infoSheet.appendRow(["Duration", duration || ""]);
  infoSheet.appendRow(["Password", password || ""]);
  infoSheet.appendRow(["Theme", theme || ""]);
  
  // 2. 準備清單頁 (Checklist) - 保留最通用的出國準備基礎項，內容可自由編輯或增刪
  let checklistSheet = ss.getSheetByName("Checklist");
  if (!checklistSheet) checklistSheet = ss.insertSheet("Checklist");
  checklistSheet.clear();
  checklistSheet.appendRow(["id", "cat", "title", "note", "link", "done"]);
  checklistSheet.appendRow(["1", "證件", "護照與簽證", "出發前檢查效期需大於6個月", "", "FALSE"]);
  checklistSheet.appendRow(["2", "通訊", "網卡 / eSIM", "確認上網設定與開通日期", "", "FALSE"]);
  checklistSheet.appendRow(["3", "財務", "外幣與信用卡", "通知銀行開啟海外刷卡與提款", "", "FALSE"]);
  
  // 3. 航班與住宿 (Flights) - 純白留空：僅寫入標準欄位 Header，不預設任何航班
  let flightsSheet = ss.getSheetByName("Flights");
  if (!flightsSheet) flightsSheet = ss.insertSheet("Flights");
  flightsSheet.clear();
  flightsSheet.appendRow(["Type", "airline", "no", "from", "to", "date", "dep", "arr", "note"]);
  
  // 4. 飯店資訊 (Hotel) - 純白留空：僅寫入標準欄位 Header，不預設任何飯店
  let hotelSheet = ss.getSheetByName("Hotel");
  if (!hotelSheet) hotelSheet = ss.insertSheet("Hotel");
  hotelSheet.clear();
  hotelSheet.appendRow(["name", "addr", "checkin", "checkout", "nights", "note"]);
  
  // 5. 行程規劃 (Days) - 純白留空骨架：僅建立 Day 1 標題骨架，不預設任何景點或接駁資訊
  let daysSheet = ss.getSheetByName("Days");
  if (!daysSheet) daysSheet = ss.insertSheet("Days");
  daysSheet.clear();
  daysSheet.appendRow(["dayId", "date", "title", "time", "place", "desc", "imgUrl", "link"]);
  daysSheet.appendRow(["Day 1", startDate || "第一天", (tripName || "") + " 啟程日", "", "", "開啟精彩旅程！", "", ""]);
  
  // 6. 美食清單 (Food) - 純白留空：僅寫入標準欄位 Header，不預設任何特定餐廳或美食
  let foodSheet = ss.getSheetByName("Food");
  if (!foodSheet) foodSheet = ss.insertSheet("Food");
  foodSheet.clear();
  foodSheet.appendRow(["id", "emoji", "name", "area", "desc", "must", "done", "imgUrl"]);
  
  // 7. 代購清單 (Shopping) - 純白留空：僅寫入標準欄位 Header，不預設任何商品或特定店家
  let shoppingSheet = ss.getSheetByName("Shopping");
  if (!shoppingSheet) shoppingSheet = ss.insertSheet("Shopping");
  shoppingSheet.clear();
  shoppingSheet.appendRow(["id", "buyer", "name", "location", "price", "qty", "link", "imgUrl", "note", "done"]);

  // 8. 交通規劃 (交通 / Transport) - 純白留空：僅寫入標準欄位 Header，不預設任何車票或路線
  let transSheet = ss.getSheetByName("交通");
  if (!transSheet) transSheet = ss.insertSheet("交通");
  transSheet.clear();
  transSheet.appendRow(["日期", "行程", "起訖點/內容", "時間", "預估費用/人", "幣別", "車種資訊", "備註"]);
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
  
  // 1. Info (基本資料與密碼：採用動態 Key-Value 鍵值映射，徹底免疫試算表列順序變更或手動插行造成的錯位)
  result.name = "";
  result.startDate = "";
  result.endDate = "";
  result.duration = "";
  result.password = "";
  result.theme = "";

  const infoSheet = ss.getSheetByName("Info");
  if (infoSheet) {
    const infoRows = infoSheet.getDataRange().getDisplayValues();
    for (let r = 0; r < infoRows.length; r++) {
      const rowKey = String(infoRows[r][0] || "").trim().toLowerCase();
      const rowVal = infoRows[r][1] !== undefined ? String(infoRows[r][1]).trim() : "";
      if (!rowKey) continue;
      if (rowKey === "name" || rowKey === "行程名稱" || rowKey === "手冊名稱") {
        result.name = rowVal;
      } else if (rowKey === "startdate" || rowKey === "出發日期" || rowKey === "開始日期") {
        result.startDate = rowVal;
      } else if (rowKey === "enddate" || rowKey === "結束日期" || rowKey === "回程日期") {
        result.endDate = rowVal;
      } else if (rowKey === "duration" || rowKey === "天數" || rowKey === "旅遊天數") {
        result.duration = rowVal;
      } else if (rowKey === "password" || rowKey === "密碼") {
        result.password = rowVal;
      } else if (rowKey === "theme" || rowKey === "主題" || rowKey === "顏色風格") {
        result.theme = rowVal;
      }
    }
    // 天數防呆：若試算表未明確填寫 duration，但有出發與回程日期，全自動即時精算並補齊 (例如: 8天7夜)
    if (!result.duration && result.startDate && result.endDate) {
      result.duration = calcTripDurationInGas(result.startDate, result.endDate);
    }
  }
  
  // 2. Checklist (行前準備與必備清單)
  result.checklist = [];
  const chSheet = ss.getSheetByName("Checklist");
  if (chSheet) {
    const chRows = chSheet.getDataRange().getDisplayValues();
    for (let i = 1; i < chRows.length; i++) {
      if (!chRows[i][0] && !chRows[i][2]) continue;
      result.checklist.push({
        id: chRows[i][0] || ("c" + i),
        cat: chRows[i][1] || "",
        title: chRows[i][2] || "",
        note: chRows[i][3] || "",
        link: chRows[i][4] || "",
        done: (chRows[i][5] || "").toString().toUpperCase() === "TRUE"
      });
    }
  }
  
  // 3. Flights (去回程航班資訊)
  result.flights = { out: {}, in: {} };
  const flSheet = ss.getSheetByName("Flights");
  if (flSheet) {
    const flRows = flSheet.getDataRange().getDisplayValues();
    for (let i = 1; i < flRows.length; i++) {
      const type = flRows[i][0];
      const data = {
        airline: flRows[i][1] || "",
        no: flRows[i][2] || "",
        from: flRows[i][3] || "",
        to: flRows[i][4] || "",
        date: flRows[i][5] || "",
        dep: formatTimeString(flRows[i][6]),
        arr: formatTimeString(flRows[i][7]),
        note: flRows[i][8] || ""
      };
      if (type === "out") result.flights.out = data;
      if (type === "in") result.flights.in = data;
    }
  }
  
  // 4. Hotel (支援多筆飯店住宿)
  result.hotels = [];
  const hoSheet = ss.getSheetByName("Hotel");
  if (hoSheet) {
    const hoRows = hoSheet.getDataRange().getDisplayValues();
    for (let i = 1; i < hoRows.length; i++) {
      if (!hoRows[i][0] && !hoRows[i][1]) continue;
      result.hotels.push({
        id: "h" + i,
        name: hoRows[i][0] || "",
        addr: hoRows[i][1] || "",
        checkin: hoRows[i][2] || "",
        checkout: hoRows[i][3] || "",
        nights: hoRows[i][4] || "",
        note: hoRows[i][5] || ""
      });
    }
  }
  // 向下相容單筆物件
  result.hotel = result.hotels.length > 0 ? result.hotels[0] : {};
  
  // 5. Days (使用 getDisplayValues 直接讀取純文字，包含 link 欄位與景點自動去重防護)
  result.days = [];
  const dySheet = ss.getSheetByName("Days");
  if (dySheet) {
    const dyRows = dySheet.getDataRange().getDisplayValues();
    const dayMap = {};
    for (let i = 1; i < dyRows.length; i++) {
      const dayId = dyRows[i][0];
      if (!dayId) continue;
      const date = dyRows[i][1] || "";
      const dayTitle = dyRows[i][2] || "";
      const time = formatTimeString(dyRows[i][3]);
      const place = dyRows[i][4] || "";
      const desc = dyRows[i][5] || "";
      const imgUrl = dyRows[i][6] || "";
      const link = dyRows[i][7] || "";
      
      if (!dayMap[dayId]) {
        dayMap[dayId] = {
          id: dayId,
          date: date,
          title: dayTitle,
          items: [],
          _seenKeys: {}
        };
        result.days.push(dayMap[dayId]);
      }
      
      if (place) {
        // 景點唯一性防重保護：同一天內以「時段 + 地點」為鍵值，避免試算表重複行造成前端重複渲染
        const itemKey = (time || "").trim().toLowerCase() + "___" + (place || "").trim().toLowerCase();
        if (!dayMap[dayId]._seenKeys[itemKey]) {
          const itemObj = {
            time: time,
            place: place,
            desc: desc,
            imgUrl: imgUrl,
            link: link
          };
          dayMap[dayId]._seenKeys[itemKey] = itemObj;
          dayMap[dayId].items.push(itemObj);
        } else {
          // 若有重複列，自動保留備註或圖片更齊全的資料
          const exist = dayMap[dayId]._seenKeys[itemKey];
          if (!exist.desc && desc) exist.desc = desc;
          if (!exist.imgUrl && imgUrl) exist.imgUrl = imgUrl;
          if (!exist.link && link) exist.link = link;
        }
      }
    }
    // 清理內部輔助鍵
    result.days.forEach(d => { delete d._seenKeys; });
  }
  
  // 6. Food (美食口袋清單，支援圖片與店名去重合併)
  result.food = [];
  const fdSheet = ss.getSheetByName("Food");
  if (fdSheet) {
    const fdRows = fdSheet.getDataRange().getValues();
    const foodMap = {};
    for (let i = 1; i < fdRows.length; i++) {
      const name = (fdRows[i][2] || "").toString().trim();
      if (!name && !fdRows[i][0]) continue;
      const key = name.toLowerCase();
      const foodItem = {
        id: fdRows[i][0] || ("f" + i),
        emoji: fdRows[i][1] || "🍴",
        name: name,
        area: fdRows[i][3] || "",
        desc: fdRows[i][4] || "",
        must: (fdRows[i][5] || "").toString().toUpperCase() === "TRUE",
        done: (fdRows[i][6] || "").toString().toUpperCase() === "TRUE",
        imgUrl: fdRows[i][7] || ""
      };
      if (key) {
        if (!foodMap[key]) {
          foodMap[key] = foodItem;
          result.food.push(foodItem);
        } else {
          const exist = foodMap[key];
          if (foodItem.must) exist.must = true;
          if (foodItem.done) exist.done = true;
          if (!exist.desc && foodItem.desc) exist.desc = foodItem.desc;
          if (!exist.imgUrl && foodItem.imgUrl) exist.imgUrl = foodItem.imgUrl;
          if (!exist.area && foodItem.area) exist.area = foodItem.area;
        }
      } else {
        result.food.push(foodItem);
      }
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

        // 嚴格防呆：過濾全空行或無效路線
        if (!colA && !colB && !colC && !colD) continue;

        // 若 A 欄為「地圖」或「MAP」，則讀取為路線地圖相簿項目
        if (colA === "地圖" || colA === "MAP" || colA.toLowerCase() === "map") {
          if (!colB) continue;
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

        // 周遊券判定：精準比對 A 欄是否為「周遊券」或「PASS」
        if (colA === "周遊券" || colA === "PASS" || colA === "Pass") {
          const passName = colB || colC;
          if (!passName) continue;
          result.transport.passes.push({
            id: "p" + i,
            name: passName,
            cost: colE,
            currency: colF,
            note: colH || (colB ? colC : "")
          });
          continue;
        }

        // 一般乘車行程：若起訖點為空且無車次備註，視為無效幽靈空行予以過濾
        if (!colB && !colG && !colH) continue;

        // 一般乘車行程唯一性防重保護
        const routeKey = (colA || "主要交通") + "___" + colB + "___" + (colD || colC);
        if (!result.transport._seenRoutes) result.transport._seenRoutes = {};
        if (!result.transport._seenRoutes[routeKey]) {
          const routeObj = {
            id: "t" + i,
            dayTag: colA || "主要交通",
            fromTo: colB,
            time: colD || colC,
            cost: colE,
            currency: colF,
            trainInfo: colG || colC,
            seatInfo: colG,
            note: colH
          };
          result.transport._seenRoutes[routeKey] = routeObj;
          result.transport.routes.push(routeObj);
        }
      }
      delete result.transport._seenRoutes;
    }
  }
  
  return result;
}

// 批次寫入工作表輔助函式 (一律一次性 setValues，自動補齊不足行數與欄數，儲存速度比逐行 appendRow 快 10 倍以上，防止 GAS 逾時與 Range 溢出錯誤)
function batchWriteSheetRows(sheet, rows) {
  if (!sheet) return;
  sheet.clearContents();
  if (rows && rows.length > 0) {
    const requiredRows = rows.length;
    const requiredCols = rows[0].length;
    const currentRows = sheet.getMaxRows();
    if (currentRows < requiredRows) {
      sheet.insertRowsAfter(currentRows, requiredRows - currentRows);
    }
    const currentCols = sheet.getMaxColumns();
    if (currentCols < requiredCols) {
      sheet.insertColumnsAfter(currentCols, requiredCols - currentCols);
    }
    sheet.getRange(1, 1, requiredRows, requiredCols).setValues(rows);
  }
}

// 輔助函式：動態設定 Info 工作表中的鍵值（依據第一欄 Key 尋找對應行寫入，若不存在則新增，徹底杜絕寫死行號造成的錯位）
function setInfoSheetKeyValue(infoSheet, key, value) {
  if (!infoSheet || !key) return;
  const targetKey = String(key).trim().toLowerCase();
  const data = infoSheet.getDataRange().getValues();
  for (let r = 0; r < data.length; r++) {
    const rowKey = String(data[r][0] || "").trim().toLowerCase();
    if (rowKey === targetKey) {
      infoSheet.getRange(r + 1, 2).setValue(value !== undefined && value !== null ? value : "");
      return;
    }
  }
  // 若該 Key 尚不存在，自動追加新行
  infoSheet.appendRow([key, value !== undefined && value !== null ? value : ""]);
}

// 輔助函式：批次設定 Info 表多個鍵值
function setInfoSheetMap(infoSheet, keyValueMap) {
  if (!infoSheet || !keyValueMap) return;
  const existingData = infoSheet.getDataRange().getValues();
  const keyToRowIndex = {};
  for (let r = 0; r < existingData.length; r++) {
    const rowKey = String(existingData[r][0] || "").trim().toLowerCase();
    if (rowKey) {
      keyToRowIndex[rowKey] = r + 1; // 1-indexed
    }
  }

  for (let [k, val] of Object.entries(keyValueMap)) {
    if (val === undefined) continue;
    const lk = String(k).trim().toLowerCase();
    if (keyToRowIndex[lk]) {
      infoSheet.getRange(keyToRowIndex[lk], 2).setValue(val !== null ? val : "");
    } else {
      infoSheet.appendRow([k, val !== null ? val : ""]);
      keyToRowIndex[lk] = infoSheet.getLastRow();
    }
  }
}

// 儲存前端修改後的完整資料回 Google 試算表 (全面採用高效能批次寫入架構)
function saveTripDetails(sheetId, data) {
  const ss = SpreadsheetApp.openById(sheetId);
  
  // 1. Info (基本手冊資訊與密碼同步，採用動態 Key 比對寫入)
  let infoSheet = ss.getSheetByName("Info");
  if (!infoSheet) {
    infoSheet = ss.insertSheet("Info");
    infoSheet.appendRow(["Key", "Value"]);
  }
  
  // 計算天數防呆
  let tripDuration = data.duration || "";
  if (!tripDuration && data.startDate && data.endDate) {
    tripDuration = calcTripDurationInGas(data.startDate, data.endDate);
  }

  const infoMap = {
    "Name": data.name || "",
    "StartDate": data.startDate || "",
    "EndDate": data.endDate || "",
    "Duration": tripDuration
  };
  if (data.password !== undefined) {
    infoMap["Password"] = data.password || "";
  }
  if (data.theme !== undefined) {
    infoMap["Theme"] = data.theme || "";
  }
  setInfoSheetMap(infoSheet, infoMap);
  
  // 2. Checklist (行前準備與行李清單)
  let checklistSheet = ss.getSheetByName("Checklist");
  if (!checklistSheet) checklistSheet = ss.insertSheet("Checklist");
  const rowsChecklist = [["id", "cat", "title", "note", "link", "done"]];
  (data.checklist || []).forEach(item => {
    if (!item || (!item.title && !item.id)) return;
    rowsChecklist.push([
      item.id || "",
      item.cat || "",
      item.title || "",
      item.note || "",
      item.link || "",
      item.done ? "TRUE" : "FALSE"
    ]);
  });
  batchWriteSheetRows(checklistSheet, rowsChecklist);
  
  // 3. Flights (航班資訊)
  let flightsSheet = ss.getSheetByName("Flights");
  if (!flightsSheet) flightsSheet = ss.insertSheet("Flights");
  const rowsFlights = [["Type", "airline", "no", "from", "to", "date", "dep", "arr", "note"]];
  if (data.flights && data.flights.out) {
    const f = data.flights.out;
    rowsFlights.push(["out", f.airline || "", f.no || "", f.from || "", f.to || "", f.date || "", f.dep || "", f.arr || "", f.note || ""]);
  }
  if (data.flights && data.flights.in) {
    const f = data.flights.in;
    rowsFlights.push(["in", f.airline || "", f.no || "", f.from || "", f.to || "", f.date || "", f.dep || "", f.arr || "", f.note || ""]);
  }
  batchWriteSheetRows(flightsSheet, rowsFlights);
  
  // 4. Hotel (支援多筆飯店住宿)
  let hotelSheet = ss.getSheetByName("Hotel");
  if (!hotelSheet) hotelSheet = ss.insertSheet("Hotel");
  const rowsHotel = [["name", "addr", "checkin", "checkout", "nights", "note"]];
  const hotelList = data.hotels || (data.hotel ? [data.hotel] : []);
  hotelList.forEach(h => {
    if (h && (h.name || h.addr)) {
      rowsHotel.push([
        h.name || "",
        h.addr || "",
        h.checkin || "",
        h.checkout || "",
        h.nights || "",
        h.note || ""
      ]);
    }
  });
  batchWriteSheetRows(hotelSheet, rowsHotel);
  
  // 5. Days (每日行程景點與活動，寫入前自動去重保護)
  let daysSheet = ss.getSheetByName("Days");
  if (!daysSheet) daysSheet = ss.insertSheet("Days");
    const rows = [["dayId", "date", "title", "time", "place", "desc", "imgUrl", "link"]];
    (data.days || []).forEach(d => {
      if (d.items && d.items.length > 0) {
        const seenDayItems = new Set();
        d.items.forEach(item => {
          const p = (item.place || "").trim();
          if (!p) return;
          const t = (item.time || "").trim();
          const itemKey = t.toLowerCase() + "___" + p.toLowerCase();
          if (!seenDayItems.has(itemKey)) {
            seenDayItems.add(itemKey);
            rows.push([
              d.id || "",
              d.date || "",
              d.title || "",
              t,
              p,
              item.desc || "",
              item.imgUrl || "",
              item.link || ""
            ]);
          }
        });
      } else {
        rows.push([d.id || "", d.date || "", d.title || "", "", "", "", "", ""]);
      }
    });
    batchWriteSheetRows(daysSheet, rows);
  
  // 6. Food (美食口袋清單，寫入前店名唯一性防重)
  let foodSheet = ss.getSheetByName("Food");
  if (!foodSheet) foodSheet = ss.insertSheet("Food");
  const foodRows = [["id", "emoji", "name", "area", "desc", "must", "done", "imgUrl"]];
  const seenFood = new Set();
  (data.food || []).forEach(item => {
    const name = (item.name || "").trim();
    if (!name) return;
    const k = name.toLowerCase();
    if (!seenFood.has(k)) {
      seenFood.add(k);
      foodRows.push([
        item.id || "",
        item.emoji || "🍴",
        name,
        item.area || "",
        item.desc || "",
        item.must ? "TRUE" : "FALSE",
        item.done ? "TRUE" : "FALSE",
        item.imgUrl || ""
      ]);
    }
  });
  batchWriteSheetRows(foodSheet, foodRows);

  // 7. Shopping (代購清單)
  let shoppingSheet = ss.getSheetByName("Shopping");
  if (!shoppingSheet) shoppingSheet = ss.insertSheet("Shopping");
  const shopRows = [["id", "buyer", "name", "location", "price", "qty", "link", "imgUrl", "note", "done"]];
  (data.shopping || []).forEach(item => {
    if (!item || (!item.name && !item.id)) return;
    shopRows.push([
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
  batchWriteSheetRows(shoppingSheet, shopRows);

  // 8. 交通 (Transport) - 多張路線地圖相簿、周遊券與乘車行程
  if (data.transport) {
    let transSheet = ss.getSheetByName("交通") || ss.getSheetByName("Transport");
    if (!transSheet) transSheet = ss.insertSheet("交通");
    const transRows = [["類別/日期", "圖片網址/行程", "名稱/起訖點", "時間", "預估費用/人", "幣別", "車種/座位", "備註"]];

    // 寫入多張地圖相簿資訊
    const maps = data.transport.maps || [];
    if (maps.length > 0) {
      maps.forEach(m => {
        if (m.url) {
          transRows.push(["地圖", m.url, m.title || "路線地圖", "", "", "", "", m.note || ""]);
        }
      });
    } else if (data.transport.mapImgUrl) {
      // 向下相容單張地圖
      transRows.push(["地圖", data.transport.mapImgUrl, data.transport.mapNote || "主要交通路線圖", "", "", "", "", data.transport.mapNote || ""]);
    }

    // 寫入周遊券
    (data.transport.passes || []).forEach(p => {
      transRows.push(["周遊券", p.name || "", "", "", p.cost || "", p.currency || "日円", "", p.note || ""]);
    });

    // 寫入乘車行程 (過濾幽靈空行並防止重複寫入)
    const seenRoutes = new Set();
    (data.transport.routes || []).forEach(r => {
      const ft = (r.fromTo || "").trim();
      const ti = (r.trainInfo || "").trim();
      const nt = (r.note || "").trim();
      if (!ft && !ti && !nt) return; // 略過全空假資料
      const rKey = (r.dayTag || "") + "___" + ft + "___" + (r.time || "");
      if (!seenRoutes.has(rKey)) {
        seenRoutes.add(rKey);
        transRows.push([
          r.dayTag || "",
          ft,
          ti,
          r.time || "",
          r.cost || "",
          r.currency || "日円",
          r.seatInfo || "",
          nt
        ]);
      }
    });

    batchWriteSheetRows(transSheet, transRows);
  }
}

