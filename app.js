require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const sqlite3 = require('sqlite3').verbose();
const OpenAI = require('openai');

const app = express();
const port = process.env.PORT || 3000;

// Line Bot 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new Client(config);

// OpenAI 設定
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 資料庫初始化 - 董事長及代理人發言記錄表
const db = new sqlite3.Database('./chairman_records.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS chairman_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    speaker_name TEXT NOT NULL,
    speaker_type TEXT NOT NULL,
    speaker_role TEXT NOT NULL,
    message_content TEXT NOT NULL,
    record_type TEXT NOT NULL,
    task_description TEXT NULL,
    priority TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // 創建索引以提高查詢效能
  db.run(`CREATE INDEX IF NOT EXISTS idx_group_id ON chairman_records(group_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_speaker_type ON chairman_records(speaker_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_record_type ON chairman_records(record_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_created_at ON chairman_records(created_at)`);
});

// 🎯 核心功能：識別是否為葛董或其代理人
function isChairmanOrDelegate(displayName) {
  const chairmanNames = [
    '葛望平',
    '葛董',
    '董事長',
    'Ge Wang Ping',
    'GE WANG PING'
  ];
  
  const delegateNames = [
    '蔡怡穎',
    '總經理',
    '林秀玲',
    '特助',
    'Cai Yi Ying',
    'Lin Xiu Ling'
  ];
  
  const isChairman = chairmanNames.some(name => 
    displayName.includes(name) || 
    displayName.toLowerCase().includes(name.toLowerCase())
  );
  
  const isDelegate = delegateNames.some(name => 
    displayName.includes(name) || 
    displayName.toLowerCase().includes(name.toLowerCase())
  );
  
  return {
    isRelevant: isChairman || isDelegate,
    type: isChairman ? 'chairman' : (isDelegate ? 'delegate' : 'other'),
    role: isChairman ? '董事長' : (isDelegate ? '代理人' : '其他')
  };
}

// 🎯 檢查是否包含葛董指示關鍵詞
function containsChairmanKeywords(message) {
  const chairmanKeywords = [
    '葛董指示', '葛董交辦', '葛董交代', '葛董要求', '葛董希望', 
    '葛董務必', '葛董說', '葛董的意見', '葛董認為',
    '董事長指示', '董事長交辦', '董事長交代', '董事長要求', 
    '董事長希望', '董事長務必', '董事長說', '董事長的意見',
    '完成', '執行', '繳交', '處理', '安排', '準備',
    '要求完成', '務必完成', '希望完成', '需要執行', '必須執行'
  ];
  
  return chairmanKeywords.some(keyword => message.includes(keyword));
}

// 🤖 AI 分析發言是否包含任務交辦（支援董事長和代理人）
async function analyzeMessage(message, speakerType, speakerName) {
  try {
    const systemPrompt = speakerType === 'chairman' 
      ? `你是董事長發言分析助手。分析董事長的發言是否包含任務交辦或重要指示。`
      : `你是代理人發言分析助手。分析代理人（總經理/特助）是否代表董事長交辦任務或傳達重要指示。

特別注意代理人常用的措辭：
- "葛董說..."、"董事長指示..."、"葛董要求..."
- "董事長交代..."、"葛董的意見是..."
- 任何提及葛董的指示、交辦、交代、要求、希望、務必等詞彙
- 即使沒有明確提及董事長，但涉及重要決策或指示的內容`;

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `${systemPrompt}

判斷標準：
- 包含明確的行動要求（如：去做、處理、安排、準備等）
- 涉及時間要求（如：今天、明天、本週等）
- 針對特定人員或部門的指派
- 重要決策或指示
- 代理人傳達董事長意見或指示

如果包含任務，回覆格式：'任務|任務描述|優先級'（優先級：高/中/低）
如果只是一般發言，回覆：'發言'

範例：
輸入：「葛董說明天董事會要準備Q3財報」
輸出：「任務|準備Q3財報供董事會使用|高」

輸入：「董事長交代要加快專案進度」
輸出：「任務|加快專案進度|高」

輸入：「今天天氣不錯」  
輸出：「發言」`
        },
        {
          role: "user",
          content: `${speakerType === 'chairman' ? '董事長' : '代理人'}發言：${message}`
        }
      ],
      max_tokens: 150,
      temperature: 0.3
    });

    const result = response.choices[0].message.content.trim();
    
    if (result === '發言') {
      return {
        type: 'speech',
        taskDescription: null,
        priority: null
      };
    }
    
    const parts = result.split('|');
    if (parts[0] === '任務' && parts.length >= 3) {
      const priority = parts[2]?.includes('高') ? 'high' : 
                      parts[2]?.includes('低') ? 'low' : 'normal';
      
      return {
        type: 'task',
        taskDescription: parts[1] || message,
        priority: priority
      };
    }
    
    // 如果AI回覆格式不正確，預設為一般發言
    return {
      type: 'speech',
      taskDescription: null,
      priority: null
    };
    
  } catch (error) {
    console.error('AI分析錯誤:', error);
    // AI失敗時，預設為一般發言
    return {
      type: 'speech',
      taskDescription: null,
      priority: null
    };
  }
}

// 📝 記錄董事長、代理人或轉達者發言
function recordMessage(groupId, speakerName, messageContent, analysisResult, speakerInfo) {
  return new Promise((resolve, reject) => {
    const { type, taskDescription, priority } = analysisResult;
    const { type: speakerType, role: speakerRole } = speakerInfo;
    
    db.run(`INSERT INTO chairman_records 
            (group_id, speaker_name, speaker_type, speaker_role, message_content, record_type, task_description, priority) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
      [groupId, speakerName, speakerType, speakerRole, messageContent, type, taskDescription, priority], 
      function(err) {
        if (err) {
          console.error('記錄儲存錯誤:', err);
          reject(err);
        } else {
          const actionType = type === 'task' ? '任務交辦' : '發言';
          console.log(`✅ 已記錄${speakerRole}${actionType}:`, messageContent.substring(0, 50) + '...');
          resolve(this.lastID);
        }
      });
  });
}

// 📋 獲取董事長及代理人記錄列表
function getRecords(groupId, type = 'all', speakerFilter = 'all') {
  return new Promise((resolve, reject) => {
    let query = 'SELECT * FROM chairman_records WHERE group_id = ?';
    const params = [groupId];
    
    // 記錄類型過濾
    if (type === 'speech') {
      query += ' AND record_type = "speech"';
    } else if (type === 'task') {
      query += ' AND record_type = "task"';
    }
    
    // 發言者類型過濾
    if (speakerFilter === 'chairman') {
      query += ' AND speaker_type = "chairman"';
    } else if (speakerFilter === 'delegate') {
      query += ' AND speaker_type = "delegate"';
    } else if (speakerFilter === 'messenger') {
      query += ' AND speaker_type = "messenger"';
    }
    
    query += ' ORDER BY created_at DESC';
    
    db.all(query, params, (err, rows) => {
      if (err) {
        console.error('查詢記錄錯誤:', err);
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

// 📊 格式化記錄顯示
function formatRecords(records) {
  if (records.length === 0) {
    return '📋 目前沒有相關的發言記錄';
  }

  let response = `📋 發言記錄（共 ${records.length} 筆）：\n\n`;
  
  records.forEach((record, index) => {
    const date = new Date(record.created_at).toLocaleString('zh-TW', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    const typeIcon = record.record_type === 'task' ? '📌' : '💬';
    const speakerIcon = record.speaker_type === 'chairman' ? '👑' : 
                        record.speaker_type === 'delegate' ? '👤' : '📢';
    const priorityIcon = record.priority === 'high' ? '🔴' : 
                        record.priority === 'low' ? '🟢' : 
                        record.priority === 'normal' ? '🟡' : '';
    
    response += `${index + 1}. ${typeIcon} ${speakerIcon} ${date}\n`;
    response += `   👤 ${record.speaker_role}：${record.speaker_name}\n`;
    
    if (record.record_type === 'task') {
      response += `   🎯 任務：${record.task_description}\n`;
      response += `   ${priorityIcon} 優先級：${record.priority === 'high' ? '高' : record.priority === 'low' ? '低' : '中'}\n`;
      response += `   💭 原文：${record.message_content}\n\n`;
    } else {
      response += `   💭 發言：${record.message_content}\n\n`;
    }
  });
  
  // 統計資訊
  const speechCount = records.filter(r => r.record_type === 'speech').length;
  const taskCount = records.filter(r => r.record_type === 'task').length;
  const chairmanCount = records.filter(r => r.speaker_type === 'chairman').length;
  const delegateCount = records.filter(r => r.speaker_type === 'delegate').length;
  const messengerCount = records.filter(r => r.speaker_type === 'messenger').length;
  
  response += `📊 統計：\n`;
  response += `💬 一般發言 ${speechCount} 筆，📌 任務交辦 ${taskCount} 筆\n`;
  response += `👑 董事長 ${chairmanCount} 筆，👤 代理人 ${delegateCount} 筆`;
  if (messengerCount > 0) {
    response += `，📢 轉達者 ${messengerCount} 筆`;
  }
  
  return response;
}

// 🎯 核心：訊息處理邏輯
async function handleEvent(event) {
  // 只處理文字訊息
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const message = event.message.text.trim();
  const userId = event.source.userId;
  
  // 只處理群組訊息
  if (event.source.type !== 'group') {
    return Promise.resolve(null);
  }
  
  const groupId = event.source.groupId;

  try {
    // 🔍 檢查是否為查詢指令
    if (message === '記錄列表' || message === '全部記錄') {
      const records = await getRecords(groupId);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: formatRecords(records)
      });
    }
    
    // 🔍 檢查是否為任務記錄查詢
    if (message === '任務記錄' || message === '任務列表') {
      const records = await getRecords(groupId, 'task');
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: formatRecords(records)
      });
    }
    
    // 🔍 檢查是否為發言記錄查詢
    if (message === '發言記錄') {
      const records = await getRecords(groupId, 'speech');
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: formatRecords(records)
      });
    }
    
    // 🔍 檢查是否為董事長記錄查詢
    if (message === '葛董記錄' || message === '董事長記錄') {
      const records = await getRecords(groupId, 'all', 'chairman');
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: formatRecords(records)
      });
    }
    
    // 🔍 檢查是否為代理人記錄查詢
    if (message === '代理人記錄' || message === '總經理記錄' || message === '特助記錄') {
      const records = await getRecords(groupId, 'all', 'delegate');
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: formatRecords(records)
      });
    }
    
    // 🔍 檢查是否為轉達者記錄查詢
    if (message === '轉達記錄' || message === '其他人記錄') {
      const records = await getRecords(groupId, 'all', 'messenger');
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: formatRecords(records)
      });
    }

    // 🎯 核心邏輯：獲取發言者資訊
    const profile = await client.getProfile(userId);
    const speakerName = profile.displayName;
    
    // 🎯 判斷是否為董事長或代理人發言
    const speakerInfo = isChairmanOrDelegate(speakerName);
    
    // 🔍 檢查是否任何人提到葛董相關關鍵詞
    const hasChairmanKeywords = containsChairmanKeywords(message);
    
    if (speakerInfo.isRelevant) {
      console.log(`🎤 偵測到${speakerInfo.role}發言: ${speakerName} - ${message.substring(0, 30)}...`);
      
      // 🤖 AI 分析發言內容
      const analysisResult = await analyzeMessage(message, speakerInfo.type, speakerName);
      
      // 📝 記錄到資料庫
      await recordMessage(groupId, speakerName, message, analysisResult, speakerInfo);
    } 
    // 🎯 如果任何人提到葛董相關關鍵詞，也要記錄
    else if (hasChairmanKeywords) {
      console.log(`🔍 偵測到葛董相關指示: ${speakerName} - ${message.substring(0, 30)}...`);
      
      // 將此人標記為「轉達者」
      const delegateInfo = {
        isRelevant: true,
        type: 'messenger',
        role: '轉達者'
      };
      
      // 🤖 AI 分析內容（使用代理人模式）
      const analysisResult = await analyzeMessage(message, 'delegate', speakerName);
      
      // 📝 記錄到資料庫
      await recordMessage(groupId, speakerName, message, analysisResult, delegateInfo);
    }
    
    // 🤐 對於其他人的發言，完全忽略，保持靜默
    return Promise.resolve(null);

  } catch (error) {
    console.error('處理訊息錯誤:', error);
    // 即使發生錯誤也保持靜默，避免干擾群組對話
    return Promise.resolve(null);
  }
}

// 路由設定
app.use('/webhook', middleware(config));
app.post('/webhook', (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('Webhook處理錯誤:', err);
      res.status(500).end();
    });
});

// 健康檢查
app.get('/', (req, res) => {
  res.json({
    status: '葛董發言記錄系統運行中 🤖',
    features: ['董事長發言記錄', '代理人任務識別', '靜默記錄'],
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// 錯誤處理
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(port, () => {
  console.log(`🚀 葛董發言記錄系統運行在 port ${port}`);
  console.log(`📱 準備接收 LINE 訊息並記錄董事長發言！`);
  console.log(`👑 支援董事長和代理人發言識別`);
});

// 優雅關閉處理
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM 信號，正在關閉服務器...');
  db.close((err) => {
    if (err) {
      console.error('關閉資料庫時發生錯誤:', err);
    } else {
      console.log('資料庫連接已關閉');
    }
    process.exit(0);
  });
});
