# macode / New API 登录集成

本项目现在可以复用 macode 的 New API MySQL 用户库。

## 本地启动

1. 启动认证桥接服务：

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

2. 启动前端：

```bash
npm run dev
```

Vite 会把 `/api/*` 代理到 `http://127.0.0.1:3004`。生产环境可以把 `VITE_AUTH_API_BASE_URL` 指向 `https://macode.cloud/api`，或在同域部署时保持 `/api`。

## 数据库复用方式

- 登录查询 New API 的 `users` 表，支持用户名或邮箱。
- 密码校验使用 bcrypt，与 New API 兼容。
- 登录成功后从 `tokens` 表读取当前用户最新可用令牌。
- 前端会把令牌自动写入当前 API Profile，并使用 `https://macode.cloud/v1` 作为 Base URL。
- 注册默认关闭：`ALLOW_PASSWORD_REGISTER=false`，避免误写生产用户表。
