# backend — Spring Boot 业务网关

Java 17 + Spring Boot 3.2 + MyBatis-Plus/JDBC + MySQL 8 + JWT。W2 新增隔离的身份、会话与工作空间；W1 接口仅保留显式兼容模式。下面 W1 回归记录是历史结果，不代表 W2 已完成实库验收。

## 本地启动

1. 准备 MySQL 8 和**专用空库** `hdr_w2`，使用限定权限的账号；不要直接指向已有 W1 或未知数据库。
2. 配置环境变量：

| 变量 | 默认值/要求 |
|---|---|
| `DB_URL` | `jdbc:mysql://localhost:3306/hdr_w2?...serverTimezone=UTC`，不自动创建库 |
| `DB_USERNAME` / `DB_PASSWORD` | `hdr` / 空，需显式提供有效账号 |
| `V2_JWT_SECRET` | 必填，至少32 UTF-8字节，必须与 `JWT_SECRET` 不同；建议密码管理器生成随机密钥 |
| `V2_JWT_EXPIRE_HOURS` | 24，范围1–168 |
| `W2_MAX_WORKSPACES` | 3，包含个人空间及停用空间；修改需重启 |
| `W2_RECOGNITION_PER_MINUTE` | 60，每用户/空间的固定分钟窗口；另有全局、IP 上传与并发保护 |
| `W2_MAX_MEMBERS` / `W2_DAILY_RECOGNITION_LIMIT` | 5 / 1000，仅预留预算；W2 无邀请和日配额账本，不表示已经强制执行 |
| `SERVER_ADDRESS` / `SERVER_PORT` | `127.0.0.1` / `8080`；容器内显式使用 `0.0.0.0` |
| `MODEL_SERVICE_URL` | `http://127.0.0.1:5001`，仅管理员配置的内部地址 |
| `MODEL_INTERNAL_TOKEN` | 必填才能推理，需与 Python 一致；不能暴露到前端 |
| `JWT_SECRET` | 仅W1兼容使用，旧开发默认值不得用于生产 |
| `HDR_LEGACY_AUTH_ENABLED` | `false`；只有受控本地兼容测试才设为true |

3. 启动：

```bash
mvn spring-boot:run
```

Flyway 是唯一迁移入口：新空库按 V1→V2→后续版本迁移；`spring.sql.init.mode=never`，不再执行旧 `db/schema.sql` 初始化，不自动 baseline 非空库，也不执行 `clean`。Compose 不应再挂载旧初始化 SQL。v2 JWT不缓存账号角色，每次请求读取会话和当前账号状态；注销后服务器撤销会话。

应用不再初始化已知密码管理员。需要W1兼容账号时，额外一次性显式设置 `HDR_LEGACY_BOOTSTRAP_ENABLED=true`、`HDR_LEGACY_BOOTSTRAP_USERNAME`、`HDR_LEGACY_BOOTSTRAP_PASSWORD`；该流程只创建不存在的账号和个人空间，授予旧 `ADMIN` 而不是 `SUPER_ADMIN`，不会重置/提升已有账号，不打印凭据，完成后必须撤掉bootstrap配置。SaaS运营账号使用下方受控提升流程。

## 身份与空间接口

W2成功返回真实HTTP状态及 `{code:0,message:"ok",data}`，所有业务ID是字符串。完整DTO见 `docs/W2-接口实现约定.md`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v2/auth/register` | 普通账号+个人空间+OWNER+默认公共模型+服务器会话，201 |
| POST | `/api/v2/auth/login` | 登录，返回token/user/defaultWorkspaceId |
| GET | `/api/v2/auth/me` | 当前安全身份与可访问默认空间 |
| POST | `/api/v2/auth/logout` | 撤销当前会话 |
| GET/POST | `/api/v2/workspaces` | 当前有效成员空间/仅名称创建空间（上限3） |
| GET | `/api/v2/workspaces/{workspaceId}` | 每次实时校验成员、空间和账号状态 |
| GET | `/api/health` | W1健康检查 |

旧 `/api/auth/register|login|me` 默认不注册路由，仅在显式兼容配置下存在，旧token与v2 token双向拒绝。运营角色不隐式获得任何空间成员权限。

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

- W2接口在 `com.hdr.v2`，使用其独立鉴权和真实HTTP异常映射；不要复用W1 `PublicApi` 绕过v2鉴权。
- 空间接口每次调用 `WorkspaceService.requireMember(workspaceId,userId)`；平台角色与空间角色分离。
- 新增表：只新增 `src/main/resources/db/migration/V<N>__description.sql`；禁止修改已发布迁移、重复schema初始化或在启动时自动baseline。
- 调用模型服务使用内部凭据与固定可信模型，失败不可用，不回落到随机/mock结果。

## W1 回归测试

在 `backend/` 执行：

```bash
mvn -B verify
```

当前 **61 项全部通过**：JWT 1 项、Service 15 项、MockMvc HTTP 45 项，打包成功。覆盖注册字段约束、默认 USER 角色、BCrypt、重复用户名、登录失败/停用账号、JWT、管理员限制与请求上下文清理。

MockMvc 使用真实 Controller、Service、校验器、异常处理器、拦截器和 JWT，仅模拟 UserMapper；它不验证 MySQL 实际落库。注册唯一键竞争已有异常转换测试，实际数据库并发验证仍待完成。W1 固定角色为 `ADMIN/USER`，不包含新增 RBAC 系统。

## W1→W2受控升级与恢复

**先在副本演练，不对用户已有数据库自动操作。** MySQL DDL会隐式提交，失败不能当成事务整体回滚。

1. 停止所有W1/W2写入进程和定时任务；确认维护窗口内没有并发DDL/写入。记录库名、MySQL版本、五张W1表行数、账号状态和旧资产清单。
2. 使用MySQL官方 `mysqldump --single-transaction --routines --triggers --events --result-file=<backup.sql> <database>` 备份（连接参数按环境提供，密码用交互提示/受控选项文件，不能写到命令行或提交Git）。计算SHA256并在另一专用库验证能够恢复；备份含密码哈希，需按敏感文件保护。helper只校验文件存在和摘要，不替代恢复演练。
3. 编译离线helper并生成类路径（在 `backend/` 执行）：

```bash
mvn -B test-compile dependency:build-classpath -Dmdep.outputFile=target/upgrade-classpath.txt
```

4. 设置 `W2_UPGRADE_URL`、`W2_UPGRADE_USERNAME`、`W2_UPGRADE_PASSWORD`，指向**已备份并核对的副本/维护库**。此账号必须能看到本库所有元数据对象；缺少元数据可见性时禁止执行。显式调用，不由应用启动触发：

```text
java -cp <target/test-classes + target/classes + target/upgrade-classpath.txt内的依赖类路径> com.hdr.v2.migration.W1UpgradeHelper --confirm-w1-baseline <精确库名> <备份文件路径> <备份SHA256>
```

Windows类路径分隔符`;`，Linux为`:`。helper核对所选库名，严格比较不可变V1定义的5张表、全部列类型/空值/默认值/额外属性、全部索引、InnoDB/utf8mb4，并拒绝其他表、视图、触发器、存储过程、事件、外键、CHECK约束或已有Flyway历史。任何不一致先人工调查，**禁止通过开启 `baseline-on-migrate` 绕过检查**。该命令只记录baseline=1，不执行W2迁移；DDL停写必须持续到下一步完成。

5. 指向同一受控库启动W2应用。Flyway执行V2及后续迁移；旧用户密码/旧角色不改动，每个未删除账号（包括停用账号）获得个人空间、OWNER与默认模型1。旧ADMIN不会获得SUPER_ADMIN；旧模型/数据集/识别数据保留在W1表、不自动公开。停用/删除账号仍不能认证。
6. 核对 `flyway_schema_history` 全部成功；比较前后W1表行数；`t_workspace WHERE personal_user_id IS NOT NULL` 数量应等于升级前 `t_user WHERE deleted=0`；OWNER成员同数；公共模型/数据集各有固定种子1；检查基线版本与预处理版本。用已有普通账号登录，查看个人空间；重启再次验证不重复创建。
7. 如迁移部分失败，保持停写，保存错误和失败阶段；恢复备份到**另一个空的受控库**并先验证W1/行数，再切回连接。不要在原库盲目 `repair`、删除历史或重复DDL。问题修复后在新的副本重新演练完整升级。回滚W2需同时回滚应用版本，不能让W1和W2共写恢复库。

## 一次性运营账号提升

先正常注册专用账号，并核对实际账号持有人。维护人员使用受控数据库连接和已备份库，在交互SQL会话执行以下流程；占位账号名必须替换，不能批量提升旧ADMIN。账号选择应同时核对查询返回ID，涉及平台权限的操作由团队内部批准并保留脱敏操作记录。

```sql
START TRANSACTION;
SELECT id, username, status, deleted, platform_role
FROM t_user WHERE username = '<已核对的专用账号>' FOR UPDATE;
-- 确认恰好一行、status=1、deleted=0；否则ROLLBACK。
UPDATE t_user SET platform_role = 'SUPER_ADMIN'
WHERE username = '<已核对的专用账号>' AND status = 1 AND deleted = 0;
-- 必须核对实际变更账号；随后撤销该账号所有旧会话，要求重新登录。
UPDATE t_auth_session SET revoked = TRUE
WHERE user_id = (SELECT id FROM t_user WHERE username = '<已核对的专用账号>');
COMMIT;
```

不改变旧 `role` 字段，不创建共享密码，不打印或记录JWT/密码。降权使用相同受控流程把 `platform_role` 改回 `USER` 并撤销会话；每次请求会重新读取真实平台角色。SUPER_ADMIN仍只能访问其有效成员空间。

## 基础体验版（pilot）

启用 `SPRING_PROFILES_ACTIVE=pilot`（不是只改网页模式）：独立个人空间、禁额外空间创建、关闭Swagger/旧认证/bootstrap、默认禁止跨域并不信任转发IP。`PILOT_REGISTRATION_CODE`只在服务端配置，16–256字符，空值关闭注册；通过JSON的pilotCode传入，仅新注册使用。默认识别10次/分钟/用户与空间。代理共享IP限制保留，未实现日账本。

新增 `POST /api/v2/auth/password`：当前会话+`{currentPassword,newPassword}`，正确原密码后更新哈希并撤销该用户所有v2会话，200 data=null。错误原密码400不会注销，失效会话401；每账号5次/15分钟，失败计数独立提交以防回滚绕过限流。新注册/新密码禁止合同空白字符，旧登录保留原值兼容。

2026-11-04本地 **122单测 + 18实库IT通过**；新增注册码、workspace限制、改密旧token失效、旧凭据兼容、并发登录/改密及失败计数验证。已有W2历史记录不改写。体验版发布仍需服务器/HTTPS/真实主体与微信账号，见 [发布清单](../docs/基础体验版-范围与发布清单.md)。

## W2自动化验证

2026-11-03在独立MySQL8.0.40实例执行：**115项单测 + 15项实库IT全部通过，BUILD SUCCESS**。实际Java启动、24项HTTP检查及10项Edge浏览器检查已通过；详情见 [W2交付记录](../docs/W2-交付与验证记录.md)。不是微信真机或Docker验收。

- `mvn -B verify`：W1回归 + v2 token/DTO/HTTP/鉴权/legacy gate/helper解析单测，不依赖MySQL。
- `mvn -B -Pmysql-it verify`：额外运行 `*IT`。必须显式设置 `W2_MYSQL_TEST_URL=jdbc:mysql://127.0.0.1:<port>/hdr_w2_it_<模板库>?serverTimezone=UTC...`、`W2_MYSQL_TEST_USERNAME`、`W2_MYSQL_TEST_PASSWORD`；缺配置时该profile失败，不把全部跳过算通过。
- 测试账号须在隔离MySQL实例中拥有创建/删除 `hdr_w2_it_*` 库及其表/约束的权限；注册回滚用表级 CHECK 约束注入会话写入失败，不需要 SUPER 或放宽二进制日志安全设置。测试创建随机同前缀新库，仅清理由本次测试成功创建的库，不清空传入模板库或其他已有库。勿使用生产服务器账号。
- 实库测试覆盖新库/重复启动、W1显式升级与未知库拒绝、注册末步失败事务回滚、并发重名、并发空间上限、会话撤销/过期与账号停用/删除、真实成员停用、空间停用和运营身份不旁路；另含公共/私有目录隔离、本人识别记录、成功幂等回放、处理中/失败/残留请求及固定窗口并发。测试通过记录以实际运行输出为准；没有数据库时仅单测通过不能称迁移已验收。

Java↔Python图片协议、超时和剩余实测项见 [图片链路验证记录](../docs/W2-Java-Python图片链路验证.md)。全项目当前验证状态见 [W2交付记录](../docs/W2-交付与验证记录.md)。
