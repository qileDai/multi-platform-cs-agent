# 部署文档

## 方式一：Docker Compose（推荐，知你快回）

证书和反向代理由宝塔做。这套编排只起后端和前端，不启动 Caddy，也不启动 RPA Worker。前端只监听本机 `127.0.0.1:8080`，不要把 8080 对公网开放。数据库、向量库、上传文件和自动备份都在卷 `cs-data` 里。

已有网站不要改。给客服系统单独用一个子域名，例如 `cs.cndistribution.com`，A 记录指向这台服务器。

```bash
cp backend/.env.example backend/.env
```

编辑 `backend/.env`，至少填这三项：

- `LLM_API_KEY`
- `ZHINI_REPLY_API_KEY`：随机串，`python -c "import secrets;print(secrets.token_hex(16))"`
- `SECRET_KEY`：换成另一把随机串

`SITE_DOMAIN` 只作备查，填子域名，不要带 `https://`。然后启动：

```bash
docker compose up -d --build
```

宝塔里添加站点 `cs.cndistribution.com`，PHP 选纯静态。申请 SSL 并开启强制 HTTPS。反向代理目标填 `http://127.0.0.1:8080`，发送域名填 `$host`，关闭缓存，并在代理配置里加上：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_set_header X-Forwarded-Proto $scheme;
proxy_read_timeout 90s;
```

工作台：`https://cs.cndistribution.com`。首次登录 `admin` / `admin123`，登录后立刻改掉。

知你快回插件：

1. 回复来源选「使用自己的回复接口」。
2. 接口地址填 `https://cs.cndistribution.com/api/integrations/zhinikuaihui/reply`。
3. 身份验证填同一把 `ZHINI_REPLY_API_KEY`。
4. 等待时间选 60 秒。
5. 点测试并保存。浏览器弹出该域名的访问授权时点允许。

Compose 会强制 `MOCK_ENABLED=false`、`DOUYIN_CHANNEL=api`、`XHS_CHANNEL=api`，并把 `RPA_API_KEY` 置空。`.env` 里即使写了 RPA 密钥，这套部署也不会走 RPA。

## 方式二：本地开发

### 后端（Windows PowerShell）

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env     # 编辑配置
uvicorn app.main:app --reload --port 8000
```

### 前端

```powershell
cd frontend
npm install
npm run dev               # 已配置代理到 localhost:8000
```

## 环境变量清单

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_API_KEY` | **是** | LLM 密钥（默认 DeepSeek） |
| `LLM_BASE_URL` / `LLM_MODEL` | 否 | 换其他 OpenAI 兼容模型时改 |
| `SECRET_KEY` | 生产必填 | JWT 签名密钥，改成随机串 |
| `EMBEDDING_API_KEY` | 否 | 不配置则 RAG 降级纯 BM25 |
| `RERANK_API_KEY` | 否 | 不配置则跳过精排 |
| `RAG_RERANK_THRESHOLD` | 否 | 无命中阈值，默认 0.35 |
| `DOUYIN_*` | 否 | 抖音凭证，见 platform-integration.md |
| `XHS_*` | 否 | 小红书凭证，见 platform-integration.md |
| `DATABASE_URL` | 否 | 默认 SQLite，可换 PostgreSQL |
| `AI_GLOBALLY_ENABLED` | 否 | AI 总开关，默认 true；设置页可运行时切换（admin） |
| `CORS_ORIGINS` | 生产按部署填 | 跨域白名单（逗号分隔）。空 = 仅同源（nginx/vite 反代无需填）。禁止 `*` |
| `MOCK_ENABLED` | 生产必须 false | Mock 注入口 `/api/mock/incoming`。开发默认 true，生产关闭后 404 |
| `DOUYIN_ACCOUNT_TYPE` | 否 | feige（抖店）/ enterprise（蓝V 企业号，RPA 频控不同） |
| `LLM_PRICE_INPUT_PER_1K` / `LLM_PRICE_OUTPUT_PER_1K` | 否 | token 单价（元/千），看板成本估算用 |
| `HUMANIZE_BASE_DELAY_MS` / `HUMANIZE_PER_CHAR_MS` | 否 | 拟人化发送节奏 |
| `SESSION_TIMEOUT_MINUTES` | 否 | AI 会话超时自动关闭，默认 30 分钟 |
| `SESSION_CLOSE_MESSAGE` | 否 | 超时关闭的结束语 |
| `ALERT_WEBHOOK_URL` | 生产建议 | 钉钉/企微机器人地址，异常告警推送 |
| `ALERT_COOLDOWN_SECONDS` | 否 | 同类告警冷却期，默认 600 秒 |
| `LLM_FALLBACK_*` | 生产建议 | 备用 LLM（BASE_URL/API_KEY/MODEL），主模型故障自动切换 |
| `BACKUP_DIR` / `BACKUP_INTERVAL_HOURS` / `BACKUP_KEEP` | 否 | 自动备份目录/间隔/保留份数 |

## 生产数据库（PostgreSQL）

SQLite 适合单机小流量（日咨询 < 500）。以下情况建议直接上 PostgreSQL：
队列任务高频读写、多客服并发操作、需要 Point-in-Time 恢复。

### 1. 起库（Docker 示例）

```bash
docker run -d --name cs-postgres \
  -e POSTGRES_PASSWORD=<强密码> -e POSTGRES_DB=cs_agent \
  -v cs-pgdata:/var/lib/postgresql/data -p 5432:5432 postgres:16
```

### 2. 配置

```
# backend/.env
DATABASE_URL=postgresql+psycopg2://postgres:<强密码>@127.0.0.1:5432/cs_agent
```

首次启动 `init_db()` 自动建全量表（无需手动 DDL）。驱动依赖：`pip install psycopg2-binary`。

### 3. 从 SQLite 迁移存量数据（可选）

```bash
# 导出 SQLite 数据 → 导入 Postgres（按外键依赖顺序）
sqlite3 backend/data/app.db .dump > dump.sql
# 手工清理 SQLite 方言（PRAGMA/AUTOINCREMENT 等）后：
psql -h 127.0.0.1 -U postgres -d cs_agent -f dump.sql
```

数据量大或结构复杂时建议用 pgloader：`pgloader sqlite://backend/data/app.db postgresql://postgres:<密码>@127.0.0.1/cs_agent`

### 4. 验证

```
cd backend && pytest tests/ -q   # 测试用例与数据库方言无关，全绿即兼容
```

注意：`_ensure_column` 轻量迁移仅在 SQLite 下生效；PostgreSQL 存量 schema 变更请引入 Alembic。

## 数据备份

系统默认每 24 小时自动备份到 `BACKUP_DIR`（SQLite 用安全备份 API，Chroma 整目录拷贝），滚动保留最近 7 份。

手动备份以下目录/卷即可完整备份：
- SQLite：`backend/data/app.db`（或 docker volume）
- Chroma 向量库：`backend/data/chroma/`
- 上传文档：`backend/data/uploads/`

## 生产部署 checklist

完整逐项清单见 [deployment-checklist.md](deployment-checklist.md)。最低要求：

1. `SECRET_KEY` 改为强随机串
2. 登录后台修改默认管理员密码（admin / admin123）
3. `MOCK_ENABLED=false`，`CORS_ORIGINS` 按部署填写（同源反代保持为空）
4. webhook 地址需要公网 HTTPS（可用 nginx/caddy 反代 + 证书）
5. 抖音/小红书后台配置 webhook 为 `https://你的域名/webhooks/{platform}`
6. 数据库建议换 PostgreSQL（改 `DATABASE_URL` 即可）

## 常见问题

**Q: pip install chromadb 很慢/失败？**
A: chromadb 依赖较多属正常；Windows 需 Python 3.11 64 位。失败可先装 `pip install chromadb --no-cache-dir`。

**Q: 启动后 AI 不回复？**
A: 访问 `/api/health` 检查 `llm: true`；查看后端日志。未配置 LLM 时系统会固定话术 + 转人工。

**Q: webhook 收不到平台消息？**
A: 检查回调地址公网可达、平台后台事件已订阅、`/api/health` 中平台凭证为 true。
