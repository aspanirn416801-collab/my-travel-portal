# 旅遊手冊系統 20260917_08-regression 回歸修復與驗收指引

本文件詳細記錄 `20260917_08-regression` 版本的修復進展、核心架構修正以及本地驗證方式。

---

## 一、本次回歸修正項目詳細對照表

| 項目分類 | 修正前狀況 / 具體缺陷 | 本次修正與防護實作 | 驗證方式與狀態 |
| :--- | :--- | :--- | :--- |
| **P0 航班頁 ReferenceError** | `renderFlights()` 引用未定義之 `isAdmin`，導致航班與飯店整頁渲染中斷拋錯。 | 移除多餘的 `addHotelBtn`（標題旁已具備受 `canEdit` 保護的新增按鈕）。 | **通過 (靜態與渲染測試)** |
| **P0 GAS JWT 本地偽解碼** | 官方 Tokeninfo 失敗時直接使用 `decodeJwtPayload` 本地解碼，未驗證簽章與發行方。 | 徹底移除 `decodeJwtPayload`，嚴格僅信任 Google 官方 Tokeninfo；驗證失敗一律拒絕。 | **通過 (程式碼校驗)** |
| **P0 GAS 建立行程孤立檔案** | `createTrip` 查重前已先建立 Drive 資料夾與試算表，UUID 重複時留下孤立垃圾檔案。 | 將 UUID 格式查重提到最前置，在確認未重複前絕不建立任何 Drive 檔案。 | **通過 (程式邏輯校驗)** |
| **P1 刪除天數保護與等待** | `deleteCurrentDay()` 裸呼叫 `save()`；若天數全數刪光會觸發後端防呆造成資料脫節。 | 1. 加入 `days.length <= 1` 禁止刪除最後一天之防呆；<br>2. 補齊 `const ok = await save(); return ok !== false;`。 | **通過 (程式碼校驗)** |
| **P1 儲存失敗精準回滾** | 原快照在資料修改後才建立，失敗時還原的仍是修改後資料，造成假性成功。 | 建立全域 `lastConfirmedTripData`，每次成功同步時更新；任一操作儲存失敗時立即回滾至已確認快照並重繪。 | **通過 (模擬回滾測試)** |
| **P1 請求風暴與防串頁** | 1. 僅以 Token 去重，切換行程時舊回應可能套入新行程；<br>2. 舊 Promise 完成時可能清除新 Promise。 | 1. 複合鍵 `\${token}__\${tripUuid}` 去重；<br>2. 回應嚴格比對 `currentTripUuid === requestedTripUuid`；<br>3. `finally` 僅在自身仍為進行中 Promise 時安全清空。 | **通過 (併發邏輯校驗)** |
| **P1 勾選與排序儲存等待** | Checklist、美食、代購、景點順序調整與時段自動排序 5 處仍為裸呼叫 `save()`。 | 將 `toggleChecklistItem`、`moveItineraryItem`、`autoSortCurrentDayItems`、`toggleFoodDone`、`toggleShoppingDone` 全面改為 `async/await save()`。 | **通過 (程式碼校驗)** |
| **P1 無 PIN 行程防誤鎖** | `showTripView()` 傳遞空字串給要求布林的 `isTripUnlocked()`，無密碼行程被錯誤鎖定。 | `isTripUnlocked` 內部加入 `if (!tripHasPassword) return true;`，並於呼叫端明確轉換布林。 | **通過 (邏輯校驗)** |
| **P1 後台清單真實呈現** | `fetchTrips()` 過濾敏感欄位後，後台清單顯示「尚未綁定」或「公開無密碼」等假資訊。 | 後台清單卡片改為呈現安全摘要，引導管理員點選「✏️ 編輯設定」透過 `getTripMeta` 讀取完整真實資料。 | **通過 (UI 結構校驗)** |
| **P2 HTML 屬性跳脫** | `escapeAttribute()` 僅有定義，各表單 input 的 `value="\${...}"` 未實際套用。 | 全面套用 `escapeAttribute()` 至所有表單 input 的 `value` 屬性（共計 25 處）。 | **通過 (屬性跳脫檢查)** |
| **P2 GAS bootstrap 合併請求** | 登入後先等 `getTrips` 再等 `getTripData`，受冷啟動影響耗時倍增。 | GAS 新增 `action=bootstrap` 端點，單次連線一次帶回角色、行程清單與當前行程手冊資料。 | **通過 (端點校驗)** |
| **測試檔正式納入 Git** | 先前測試腳本跑完即被刪除，無法在倉庫中復現。 | 正式將 `verify_v08_regression.js` 納入 Git 追蹤，任何人均可透過 `node verify_v08_regression.js` 復現。 | **通過 (Git 追蹤)** |

---

## 二、驗收矩陣：程式靜態檢驗 vs. 實體帳號實測

| 驗收項目 | 驗收方式 | 當前狀態 | 說明 |
| :--- | :--- | :--- | :--- |
| **JS / GAS 語法檢查** | `node -c app.js; node -c gas-code.js` | **通過** | 均無語法錯誤。 |
| **自動化回歸檢測** | `node verify_v08_regression.js` | **12 項全數通過** | 涵蓋所有 P0、P1、P2 程式邏輯測試。 |
| **版本標籤一致性** | 靜態檔案核對 | **通過** | `index.html` 與 `app.js` 均已升級至 `20260917_08`。 |
| **管理員實體登入角色切換** | 實體帳號登入瀏覽器測試 | **待使用者實測** | 需以管理員帳號於瀏覽器登入，確認角色切換為 `admin` 且後台按鈕正常顯示。 |
| **授權成員免 PIN 進入手冊** | 實體帳號登入瀏覽器測試 | **待使用者實測** | 將成員帳號加入主表 `allowed_users`，確認登入後免輸 PIN 直接開啟該行程。 |
| **授權成員修改 7 類內容表** | 實體帳號登入瀏覽器測試 | **待使用者實測** | 成員登入後修改清單或景點，確認雲端儲存成功，且 Info 表資料未被變更。 |
| **管理員 PIN 保持與變更** | 實體帳號登入瀏覽器測試 | **待使用者實測** | 於後台測試保持現有 PIN、修改 PIN 與取消 PIN 三種場景。 |
| **圖片上傳至 Google Drive** | 實體帳號登入瀏覽器測試 | **待使用者實測** | 於前端上傳照片，確認檔案寫入 Google Drive 且縮圖正確呈現。 |

---

## 三、如何本機復現驗證

在專案目錄下執行：
```bash
node verify_v08_regression.js
```
腳本將依序對上述 12 項關鍵回歸點進行實體驗證並輸出結果報告。
