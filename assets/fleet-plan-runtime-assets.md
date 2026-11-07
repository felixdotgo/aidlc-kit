# Nghiên cứu hiện trạng & kế hoạch chi tiết — runtime-assets (`assets/`)

> Deliverable thuộc item `runtime-assets` của task
> `nghi-n-c-u-t-nh-tr-ng-hi-n-t-i-v-l-n-k-ho-ch-chi-ti-t-cho-ch-loop-fleet-*`.
> Đây là tài liệu **nghiên cứu + kế hoạch** (không phải code). Chỉ sở hữu area
> `assets/`; các area khác (`src/`, `docs/`, `services/`, `test/`) do item khác
> phụ trách và được nêu ở đây dưới dạng dependency chéo, không sửa trực tiếp.

---

## 📋 Hiện trạng (current state)

`assets/` là cây kernel được cài vào project dưới dạng `.agents/aidlc/` (xem
`docs/architecture.md` §Source-to-consumer flow). Nó gồm hai nhánh:

- `assets/aidlc/` — contracts (`orchestrator.md`, `phase-*.md`, `conventions.md`),
  templates, JSON schemas, topology profiles, rules, Dockerfiles, và các script
  lifecycle + loop chạy dependency-free.
- `assets/ui/` — CSS dashboard (`bulma.min.css`, `dashboard.css`).

Runtime loop/fleet nằm trong `assets/aidlc/scripts/` và `assets/aidlc/scripts/lib/`:

| Module | Vai trò |
| --- | --- |
| `loop.mjs` | Loop local single-task (run/resume/status), lead chạy trên host, `requireLocalAuthority()`. |
| `loop-entry.mjs` | Entry daemon dùng chung (start/intake/status/worker-image/dashboard actions), rẽ nhánh local vs fleet. |
| `loop-gate.mjs` | Duyệt gate chỉ qua trusted host terminal (local). |
| `remote-state.mjs` | Lifecycle CLI cho fleet authority (client remote). |
| `state.mjs` / `context.mjs` / `task-next.mjs` / `gate-check.mjs` / `gate-view.mjs` / `render.mjs` / `assignment.mjs` | Lifecycle scripts dùng chung (local; fleet dùng qua remote-state). |
| `lib/loop-runtime.mjs` | Loop local: record, checkpoint, turn orchestration, pause/resume. |
| `lib/loop-fleet.mjs` | Fleet: `reconcileFleetJobs`, `runFleetCoordinator`, `runFleetWorker`. |
| `lib/loop-fleet-cli.mjs` | CLI fleet (coordinator/feature/worker/supervisor), remote repository + Docker worker driver. |
| `lib/loop-fleet-supervisor.mjs` | Supervisor loop (lease + gate checkpoint). |
| `lib/loop-fleet-remote.mjs` | Remote repository adapter (`createFleetRemoteRepository`). |
| `lib/loop-drivers.mjs` | Agent driver adapters `codex`/`claude`/`opencode`. |
| `lib/loop-worker-docker.mjs` | Docker worker invocation + redirect XDG cho OpenCode + credential keys. |
| `lib/loop-worker-image.mjs` | Build/resolve worker image. |
| `lib/loop-lead-sandbox.mjs` | Isolated **lead** container (từ chối `opencode`). |
| `lib/loop-local-workers.mjs` | Local Docker worker batch (worktree + snapshot + integrate). |
| `lib/loop-supervisor*.mjs`, `lib/loop-daemon.mjs`, `lib/loop-authority.mjs`, `lib/loop-git.mjs`, `lib/loop-lease.mjs`, `lib/assignment-store.mjs`, `lib/feature-store.mjs`, `lib/loop-intake.mjs`, `lib/loop-commit-message.mjs`, `lib/loop-worker-snapshot.mjs`, `lib/remote-state-client.mjs`, `lib/store.mjs`, `lib/context-runtime.mjs`, `lib/runtime.mjs`, `lib/authority.mjs` | Hạ tầng hỗ trợ (store/lock/lease/git/assignment/feature). |

Nhận xét tổng quan: code runtime không có `TODO/FIXME`; các module nhỏ
(`runtime.mjs`, `authority.mjs`, `loop-planner.mjs`) là barrel/guard/scheduler
hoàn chỉnh, không phải stub. **Điểm "chưa ổn định" của area này nằm ở sự thiếu
nhất quán giữa contract (message lỗi, JSON schema) và hành vi thực tế**, chứ không
nằm ở logic vòng lặp.

---

## 🔍 Phát hiện (findings)

### F1 — `OPENCODE_CONTAINER_ERROR` nói sai đối tượng (contract drift trong `assets/`)

- `assets/aidlc/scripts/lib/loop-worker-docker.mjs:11` định nghĩa:
  `OPENCODE_CONTAINER_ERROR = 'OpenCode workers require file-based credentials and are not available in isolated containers yet'`.
- Hằng này **chỉ được throw ở `loop-lead-sandbox.mjs:49` cho isolated LEAD**, không
  bao giờ cho worker. Comment cùng file (`loop-worker-docker.mjs:5-10`) lại mô tả
  đúng ("The isolated LEAD container still rejects OpenCode…").
- Kết luận: nội dung message ("…workers…") mâu thuẫn với nơi sử dụng (lead). Cần
  đổi thành thông điệp về **lead**, ví dụ: *"OpenCode lead turns require
  file-based credentials and are not available in isolated lead containers yet;
  run the lead on the host, or use codex/claude for an isolated lead."*

### F2 — `schemas/config.schema.json` thiếu block `loop`

- `assets/aidlc/schemas/config.schema.json` khai báo `additionalProperties: false`
  ở top-level và **không có property `loop`**, trong khi runtime thực sự đọc:
  - `loop.mode` / `loop.agents.lead` / `loop.agents.workers` — `loop-entry.mjs:54-59`.
  - `loop.workerImage[provider]` — `loop-worker-image.mjs:57-63`, `loop-fleet-cli.mjs:66-75`.
  - `loop.pollMs` / `loop.limits` — `loop-entry.mjs:81`, `loop-daemon.mjs`.
- `docs/configuration.md:93-112` đã mô tả các field này. Đây là drift giữa schema
  (contract) và cấu hình thực tế. Việc xác minh cách `src/profiles.ts` validate
  schema thuộc item `typescript-domain` (dependency chéo); phần sửa **schema file**
  thuộc area này.

### F3 — Mâu thuẫn docs về "fleet worker có hỗ trợ OpenCode hay không" (decision `fleet-opencode-worker`)

Ground truth từ code trong `assets/`:

- `loop-worker-docker.mjs:26-33` (`workerCredentialKeys`) xử lý `opencode` với
  credential env (`openai/`→`OPENAI_API_KEY`, `anthropic/`→`ANTHROPIC_API_KEY`,
  còn lại `OPENCODE_API_KEY`).
- `loop-worker-docker.mjs:43,56` (`workerDockerInvocation`) cho phép `opencode` và
  redirect `XDG_*`/`OPENCODE_DB` vào `HOME` tạm của worker.
- `loop-fleet-cli.mjs:107-186` (worker role) nhận `workerAgent=opencode`, build image
  `aidlc-worker-opencode:local`, và chạy turn qua `workerDockerInvocation`.
- `loop-drivers.mjs:82-106` đã đăng ký adapter `opencode`.

⇒ **Fleet worker containers CÓ hỗ trợ OpenCode** (qua env credentials + XDG
redirect). Chỉ **isolated LEAD container** từ chối OpenCode
(`loop-lead-sandbox.mjs:49`).

Docs đang mâu thuẫn:

| Tài liệu | Khẳng định | Đúng/Sai |
| --- | --- | --- |
| `docs/architecture.md:81` | "fleet worker containers reject OpenCode" | ❌ Sai |
| `docs/operating-workflow.md:126` | "…and fleet worker containers reject `opencode`…" | ❌ Sai |
| `docs/coordination-service.md:73` | "worker containers run all of them, including `opencode`…" | ✅ Đúng |
| `docs/configuration.md:112` | "…fleet worker containers accept OpenCode…" | ✅ Đúng |
| `docs/command-reference.md:173` | "…fleet worker containers accept OpenCode…" | ✅ Đúng |
| `docs/loop-runbook.md:96` | "Docker workers (local and fleet) authenticate OpenCode…" | ✅ Đúng |

Hai tài liệu sai (`architecture.md`, `operating-workflow.md`) thuộc area `docs/`
(item `documentation`), nên việc sửa chúng là dependency chéo; phần thuộc `assets/`
là (a) sửa message `OPENCODE_CONTAINER_ERROR` (F1) và (b) đảm bảo comment mô tả
đúng vai trò lead vs worker.

---

## 🎯 End-state fleet (decision `fleet-endstate`)

Từ góc nhìn area `assets/` (runtime loop scripts + contracts), end-state cần đạt:

1. **Ba provider đều chạy được ở đúng vị trí**: `codex`/`claude`/`opencode` làm
   worker (local lẫn fleet) qua env credentials; isolated **lead** giới hạn
   `codex`/`claude`, từ chối `opencode` với diagnostic rõ ràng, **không** fallback
   về host.
2. **Contracts nhất quán với hành vi** (single source of truth là code):
   - Message lỗi OpenCode phải nói đúng "lead", không nói "workers" (F1).
   - `config.schema.json` phải khai báo đầy đủ `loop.*` mà runtime đọc (F2).
   - Không còn mâu thuẫn docs về fleet worker + OpenCode (F3, phối hợp với item
     `documentation`).
3. **Phân vùng không-overlap được giữ và được test**: cơ chế đã có sẵn —
   `store.mjs:311-334` (`pathOverlaps`/`partitionDiagnostics` → `PARTITION_OVERLAP`
   / `PARTITION_SCOPE`), `store.mjs:349-362` (`selectBuildBatch`), và fleet dispatch
   bỏ qua item overlap (`loop-fleet.mjs:210`). Đây là "hợp đồng" chống overlap mà
   title task yêu cầu; end-state phải đảm bảo nó vẫn strict khi `loop.mode` bật.
4. **Fleet vẫn experimental nhưng được tài liệu trung thực**: đúng như
   `docs/coordination-service.md:3-4` và `docs/architecture.md:51-52` đã cảnh báo.

---

## 🧩 Giải quyết decision `fleet-opencode-worker`

**Trả lời:** Fleet worker **có hỗ trợ OpenCode**.

- Căn cứ code: `loop-worker-docker.mjs` (env credential + XDG redirect),
  `loop-fleet-cli.mjs` (worker role), `loop-drivers.mjs` (adapter opencode).
- Phân biệt đúng vai trò:
  - **Lead chạy trên host** (local + fleet daemon lead): hỗ trợ cả 3 (`codex`/
    `claude`/`opencode`).
  - **Worker container** (local + fleet): hỗ trợ cả 3, OpenCode dùng env key theo
    prefix model (`AIDLC_OPENCODE_MODEL`).
  - **Isolated lead container**: chỉ `codex`/`claude`; `opencode` bị từ chối vì
    credential file-based.
- Hệ quả cho area này: không thay đổi hành vi, chỉ sửa message/comment cho khớp
  (F1) và ghi lại kết luận để item `documentation` sửa 2 docs sai.

---

## 🧩 Breakdown công việc độc lập (không overlap)

Đề xuất chia công việc thuộc area `assets/` thành các sub-item sở hữu **path rời
nhau hoàn toàn**, có thể chạy song song. (Việc chốt `ownedPaths`/`dependsOn` vào
workplan là của lead; đây là đề xuất có căn cứ.)

| Sub-item | ownedPaths (đề xuất) | Nội dung | Phụ thuộc |
| --- | --- | --- | --- |
| `assets-opencode-error-msg` | `assets/aidlc/scripts/lib/loop-worker-docker.mjs` | Sửa `OPENCODE_CONTAINER_ERROR` + comment cho nói đúng "lead" (F1). | — |
| `assets-config-loop-schema` | `assets/aidlc/schemas/config.schema.json` | Bổ sung block `loop` (`mode`, `agents{lead,workers}`, `workerImage`, `pollMs`, `limits`) cho khớp runtime (F2). | — |
| `assets-lead-sandbox-comment` | `assets/aidlc/scripts/lib/loop-lead-sandbox.mjs` | Đồng bộ comment/usage với message mới (cùng ý F1, path khác file). | — |
| `assets-partition-guards-test` | (read-only; evidence thuộc item `test-suite`) | Xác minh `pathsOverlap`/`selectBuildBatch` giữ nguyên hành vi — giao cho `test-suite`. | sau F1/F2 |

Ghi chú phân vùng:

- Ba sub-item đầu sở hữu **3 file khác nhau** (`loop-worker-docker.mjs`,
  `config.schema.json`, `loop-lead-sandbox.mjs`) ⇒ không overlap theo
  `pathOverlaps` (`store.mjs:313`, overlap theo path-segment `a`/`a/b`, không phải
  `ab`).
- Không sub-item nào chạm `assets/ui/`, `assets/aidlc/orchestrator.md`,
  `phase-*.md`, `templates/`, `profiles/`, `rules/`, `docker/` ⇒ giữ nguyên công
  việc không liên quan.
- Dependency chéo (KHÔNG sửa ở area này): sửa 2 docs sai (F3) thuộc
  `docs/architecture.md` + `docs/operating-workflow.md` (item `documentation`);
  xác minh validator config thuộc `src/profiles.ts` (item `typescript-domain`);
  thêm coverage thuộc `test/` (item `test-suite`).

---

## ⚠️ Rủi ro / edge cases

- **F2 schema drift**: `additionalProperties: false` khiến config có `loop` có thể
  bị validator coi là invalid. Nếu `src/profiles.ts` đang validate strict mà schema
  chưa có `loop`, việc bật loop có thể fail ở bước config — cần xác minh chéo với
  item `typescript-domain` trước khi chốt (risk **high**).
- **Image build cần network**: `Dockerfile.opencode` = `npm install -g @opencode/cli`
  tại thời điểm build; worker image phải được build trước hoặc dùng registry
  (đã ghi ở `docs/troubleshooting.md:98`). Không thuộc phạm vi sửa code ở area này.
- **Fleet vẫn experimental**: contracts/field có thể đổi incompatibly trước `1.0.0`
  (`docs/coordination-service.md:3-4`). Kế hoạch chỉ "ổn định hoá" phần contract đã
  có hành vi rõ, không đổi surface.
- **Phạm vi sửa chỉ là message/schema/comment**: không đổi hành vi vòng lặp, không
  đổi credential, không đổi partition guard ⇒ rủi ro regression thấp, nhưng vẫn cần
  chạy test/lint liên quan sau khi áp dụng.

---

## 📌 Spec traceability

| Anchor | Ý nghĩa cho area này |
| --- | --- |
| `assets/aidlc/scripts/lib/loop-worker-docker.mjs:5-11,26-33,43,56` | Hành vi OpenCode worker (env credential + XDG redirect) — ground truth cho F1/F3. |
| `assets/aidlc/scripts/lib/loop-lead-sandbox.mjs:49` | Nơi duy nhất từ chối OpenCode (isolated lead) — ground truth cho F1/F3. |
| `assets/aidlc/scripts/lib/loop-fleet-cli.mjs:107-186` | Fleet worker role chấp nhận OpenCode — ground truth cho F3. |
| `assets/aidlc/schemas/config.schema.json:4,5,16` | `additionalProperties:false` + không có `loop` — nguồn F2. |
| `assets/aidlc/scripts/lib/store.mjs:311-334,349-362` | Partition guard (`pathOverlaps`, `partitionDiagnostics`, `selectBuildBatch`) — nền tảng chống overlap. |
| `assets/aidlc/scripts/lib/loop-fleet.mjs:204-210` | Fleet dispatch bỏ qua item overlap — chống overlap ở fleet. |
| `assets/aidlc/orchestrator.md:55` | Quy tắc "assign one writer per path", `ownedPaths`/`dependsOn`, `PARTITION_OVERLAP`/`PARTITION_SCOPE`. |
| `docs/architecture.md:81` (sai) vs `docs/coordination-service.md:73` (đúng) | Mâu thuẫn docs F3; sửa thuộc item `documentation`. |

---

## ✅ Verification plan (cho lead khi áp dụng)

1. `node .agents/aidlc/scripts/state.mjs …` giữ nguyên lifecycle state — worker
   không mutate state/gate.
2. Sau khi áp dụng sub-item:
   - F1/F3: grep `OPENCODE_CONTAINER_ERROR` chỉ còn xuất hiện ở lead sandbox, nội
     dung nói "lead".
   - F2: validate lại `config.json` mẫu có `loop` bằng schema mới.
   - Chạy test/lint hẹp nhất cho area (`npm test` / `npm run lint`) — giao item
     `test-suite` bổ sung coverage partition guard.
3. Evidence: ghi `--kind test|lint --area root` (hoặc area tương ứng) với kết quả
   thật; không tự ghi `pass` khi chưa chạy.

---

## Residual risks (tổng kết)

- F2 phụ thuộc xác minh validator ở `src/` (chưa sửa ở area này).
- F3 cần item `documentation` sửa 2 docs sai; nếu không đồng bộ, mâu thuẫn docs
  vẫn còn dù code đã nhất quán.
- Fleet vẫn experimental: end-state ở trên là mục tiêu hợp lý cho release hiện tại,
  chưa phải cam kết ổn định API trước `1.0.0`.
