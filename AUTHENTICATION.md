# macode / New API 登录集成

本项目现在可以复用 macode 的 New API MySQL 用户库。

## 本地启动

1. 安装前端和认证桥依赖，并复制认证桥配置：

```bash
npm install
npm --prefix server install
cp server/.env.example server/.env
```

2. 启动本地开发服务：

```bash
npm run dev
```

`npm run dev` 会同时启动 Vite 前端和认证桥接服务。若已经单独运行认证桥，可用 `npm run dev:frontend` 只启动前端。

本地开发默认通过 Vite 的 `/api` 代理转发到 `http://127.0.0.1:3004`。生产环境可以把 `VITE_AUTH_API_BASE_URL` 指向 `https://macode.cloud/api`，或在同域部署时保持 `/api`。

后端既支持单独配置 `DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_NAME`，也支持直接复用 New API 的 Go 风格 `SQL_DSN`：

```env
SQL_DSN=root:password@tcp(127.0.0.1:3306)/newapi?parseTime=true
```

## 数据库复用方式

- 登录查询 New API 的 `users` 表，支持用户名或邮箱。
- 密码校验使用 bcrypt，与 New API 兼容。
- 登录成功后从 `tokens` 表读取当前用户最新可用令牌。
- 前端会把令牌自动写入当前 API Profile，并使用 `https://macode.cloud/v1` 作为 Base URL。
- 注册默认关闭：`ALLOW_PASSWORD_REGISTER=false`，避免误写生产用户表。
