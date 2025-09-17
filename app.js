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

// 資料庫初始化
const db = new sqlite3.Database('./tasks.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    task_content TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL
  )`);
});

// AI 任務分析功能
async function analyzeTask(message) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "你是任務分析助手。從用戶訊息中提取任務內容。如果訊息包含任務，請簡潔地描述任務。如果不是任務，回覆'非任務訊息'。"
        },
        {
          role: "user",
          content: message
        }
      ],
      max_tokens: 100,
      temperature: 0.3
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error('AI分析錯誤:', error);
    return message; // 如果AI分析失敗，直接返回原始訊息
  }
}

// 任務管理功能
function addTask(userId, taskContent) {
  return new Promise((resolve, reject) => {
    db.run('INSERT INTO tasks (user_id, task_content) VALUES (?, ?)', 
      [userId, taskContent], 
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
  });
}

function getTasks(userId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC', 
      [userId], 
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
  });
}

function completeTask(userId, taskId) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE tasks SET status = "completed", completed_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
      [taskId, userId],
      function(err) {
        if (err) reject(err);
        else resolve(this.changes > 0);
      });
  });
}

function deleteTask(userId, taskId) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM tasks WHERE id = ? AND user_id = ?',
      [taskId, userId],
      function(err) {
        if (err) reject(err);
        else resolve(this.changes > 0);
      });
  });
}

// 訊息處理
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userId = event.source.userId;
  const message = event.message.text;

  try {
    // 指令處理
    if (message === '查看任務' || message === '任務列表') {
      const tasks = await getTasks(userId);
      if (tasks.length === 0) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '目前沒有任何任務 📝\n\n直接傳送訊息給我，我會幫您建立任務！'
        });
      }

      let response = '📋 您的任務列表：\n\n';
      tasks.forEach((task, index) => {
        const status = task.status === 'completed' ? '✅' : '⏳';
        const date = new Date(task.created_at).toLocaleDateString();
        response += `${index + 1}. ${status} ${task.task_content}\n   (${date})\n\n`;
      });
      response += '💡 使用方式：\n• 完成 [編號] - 標記完成\n• 刪除 [編號] - 刪除任務\n• 統計 - 查看統計資料';

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: response
      });
    }

    if (message === '統計') {
      const tasks = await getTasks(userId);
      const completed = tasks.filter(t => t.status === 'completed').length;
      const pending = tasks.filter(t => t.status === 'pending').length;
      
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `📊 任務統計：\n\n✅ 已完成：${completed} 個\n⏳ 進行中：${pending} 個\n📝 總計：${tasks.length} 個\n\n完成率：${tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0}%`
      });
    }

    if (message.startsWith('完成 ')) {
      const taskNumber = parseInt(message.replace('完成 ', ''));
      const tasks = await getTasks(userId);
      
      if (taskNumber > 0 && taskNumber <= tasks.length) {
        const task = tasks[taskNumber - 1];
        const success = await completeTask(userId, task.id);
        
        if (success) {
          return client.replyMessage(event.replyToken, {
            type: 'text',
            text: `✅ 任務已完成！\n\n"${task.task_content}"\n\n恭喜您又完成了一項任務！ 🎉`
          });
        }
      }
      
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 找不到該任務編號，請使用「查看任務」確認編號'
      });
    }

    if (message.startsWith('刪除 ')) {
      const taskNumber = parseInt(message.replace('刪除 ', ''));
      const tasks = await getTasks(userId);
      
      if (taskNumber > 0 && taskNumber <= tasks.length) {
        const task = tasks[taskNumber - 1];
        const success = await deleteTask(userId, task.id);
        
        if (success) {
          return client.replyMessage(event.replyToken, {
            type: 'text',
            text: `🗑️ 任務已刪除：\n\n"${task.task_content}"`
          });
        }
      }
      
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 找不到該任務編號，請使用「查看任務」確認編號'
      });
    }

    // 新任務處理
    const analyzedTask = await analyzeTask(message);
    
    if (analyzedTask === '非任務訊息') {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `👋 您好！我是任務管理助手\n\n🔧 可用指令：\n• 查看任務 - 查看所有任務\n• 完成 [編號] - 標記任務完成\n• 刪除 [編號] - 刪除任務\n• 統計 - 查看任務統計\n\n💡 直接傳送任務內容給我，我會自動幫您建立任務！`
      });
    }

    // 添加新任務
    const taskId = await addTask(userId, analyzedTask);
    
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ 新任務已建立！\n\n📝 任務內容：${analyzedTask}\n🆔 任務編號：${taskId}\n\n使用「查看任務」查看所有任務`
    });

  } catch (error) {
    console.error('處理訊息錯誤:', error);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '抱歉，處理您的請求時發生錯誤，請稍後再試。'
    });
  }
}

// 路由設定
app.use('/webhook', middleware(config));
app.post('/webhook', (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// 健康檢查
app.get('/', (req, res) => {
  res.send('Line Task Bot is running! 🤖');
});

app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});
