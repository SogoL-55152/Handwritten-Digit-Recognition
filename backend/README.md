# backend — Spring Boot 业务网关

Java 17 + Spring Boot 3.2 + MyBatis-Plus + MySQL + JWT。当前为工程骨架，仅包含鉴权与健康检查。

## 本地启动

1. 准备 MySQL 8（可用根目录 `docker compose up -d mysql redis`）。
2. 配置环境变量（默认值可直接运行）：

| 变量 | 默认值 |
|---|---|
| `DB_URL` | `jdbc:mysql://localhost:3306/hdr?...` |
| `DB_USERNAME` / `DB_PASSWORD` | `root` / `root` |
| `JWT_SECRET` | 开发用默认值，生产必须替换 |

3. 启动：

```bash
mvn spring-boot:run
```

应用启动时自动执行 `db/schema.sql` 并初始化管理员 `admin / admin123`（无 MNIST 数据集初始化，业务模块自行处理）。

## 现有接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册 |
| POST | `/api/auth/login` | 登录，返回 JWT |
| GET | `/api/auth/me` | 当前用户 |
| GET | `/api/health` | 健康检查 |

- Swagger UI：http://localhost:8080/doc.html
- 健康检查：http://localhost:8080/api/health

## 包结构

```
com.hdr
├── auth        JWT、登录拦截器、权限注解（@PublicApi / @RequireAdmin）
├── common      统一响应 Result、分页、异常处理
├── config      Web / MyBatis-Plus / OpenAPI / 管理员初始化
├── controller  AuthController、HealthController
├── dto         登录注册请求与响应
├── entity      数据库实体（当前仅 User）
├── mapper      MyBatis-Plus Mapper
└── service     业务逻辑（当前仅 UserService）
```

## 扩展约定

- 新增接口：在 `controller` 写 `@RestController`，业务放 `service`，返回 `Result.ok(...)`
- 公开接口加 `@PublicApi`，管理员接口加 `@RequireAdmin`
- 新增表：更新 `src/main/resources/db/schema.sql`（使用 `CREATE TABLE IF NOT EXISTS`）
- 调用模型服务：在 `client` 包中新增客户端，错误统一包装为业务码 502

## 待各成员实现

- 用户管理 CRUD 与角色权限
- 数据集、模型管理、训练任务、识别转发、统计接口
- MockMvc 接口测试
