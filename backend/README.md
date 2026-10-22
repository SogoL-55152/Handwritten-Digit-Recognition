# backend — Spring Boot 业务网关

Java 17 + Spring Boot 3.2 + MyBatis-Plus + MySQL + JWT。

## 本地启动

1. 准备 MySQL 8 与 Redis（可用根目录 `docker compose up -d mysql redis`）。
2. 配置环境变量（默认值可直接运行）：

| 变量 | 默认值 |
|---|---|
| `DB_URL` | `jdbc:mysql://localhost:3306/hdr?...` |
| `DB_USERNAME` / `DB_PASSWORD` | `root` / `root` |
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` |
| `MODEL_SERVICE_URL` | `http://localhost:5001` |
| `JWT_SECRET` | 开发用默认值，生产必须替换 |

3. 启动：

```bash
mvn spring-boot:run
```

应用启动时自动执行 `db/schema.sql` 并初始化管理员 `admin / admin123`、内置 MNIST 数据集。

## 文档与健康检查

- Swagger UI：http://localhost:8080/doc.html
- 健康检查：http://localhost:8080/api/health

## 包结构

```
com.hdr
├── auth        JWT、登录拦截器、权限注解
├── client      Flask 模型服务客户端
├── common      统一响应、分页、异常处理
├── config       Web/MyBatis/OpenAPI/初始化数据
├── controller  REST 接口
├── dto         请求与响应对象
├── entity      数据库实体
├── mapper      MyBatis-Plus Mapper
└── service     业务逻辑
```

## 接口契约

以 [`docs/03-接口契约.md`](../docs/03-接口契约.md) 为准。

## TODO（W2–W5）

- [ ] 用户注册验证码 / 密码强度策略
- [ ] 训练任务 SSE 推送（当前为 2s 轮询）
- [ ] 识别原图留存与文件存储抽象
- [ ] 接口层自动化测试（MockMvc）
