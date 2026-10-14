# Quản lý công việc cá nhân bằng local workflow

Workflow lưu công việc và ngữ cảnh trong dự án, dùng JavaScript và Node.js. Không cần tài khoản dịch vụ, API key, token hoặc Python. Ba skill chính:

| Skill | Khi dùng |
| --- | --- |
| `work-intake` | Nhận tin nhắn, ghi nhận việc cần làm hoặc bổ sung thông tin cho việc đã có. |
| `work-checkpoint` | Lưu tiến độ, phát hiện, vướng mắc và bước tiếp theo trước khi gián đoạn. |
| `work-restore` | Đọc lại ngữ cảnh và tiếp tục công việc đã lưu. |

## 1. Cập nhật `.agents` từ source hiện tại

Trong repo `aidlc-kit`, bản source có thể đã có các skill mới nhưng `.agents` vẫn là bản cũ. Mở terminal của bạn tại thư mục repo và chạy lần lượt:

```sh
npm run build
node dist/src/cli.js upgrade . --dry-run
```

Đọc phần preview. Nếu có `conflict`, dừng và gửi tên file bị xung đột cho agent để đối chiếu. Khi preview không có conflict, chạy:

```sh
node dist/src/cli.js upgrade .
```

Nhập đúng phiên bản mà terminal yêu cầu; checkout hiện tại dùng `0.0.1`. Lệnh phải chạy trong terminal tương tác và do bạn xác nhận. Không thêm `--yes` hoặc `--force`. Đây là cập nhật từ source đã build, không tải package từ npm.

Upgrade cập nhật file managed, tạo backup và giữ các file cấu hình/dữ liệu do dự án sở hữu. Terminal sẽ in đường dẫn backup dưới `.agents/data/state/backups/`. Giữ đường dẫn đó để phục hồi nếu cần; không chép đè `.agents` bằng tay hoặc sửa hash trong manifest để bỏ qua conflict.

Kiểm tra sau cập nhật:

```sh
node dist/src/cli.js status .
node dist/src/cli.js doctor . --strict
```

Các file sau cần có:

```text
.agents/aidlc/scripts/work.mjs
.agents/aidlc/work/conventions.md
.agents/aidlc/work/intake.md
.agents/aidlc/work/checkpoint.md
.agents/aidlc/work/restore.md
.agents/aidlc/work/lib/file-provider.mjs
.agents/skills/work-intake/SKILL.md
.agents/skills/work-checkpoint/SKILL.md
.agents/skills/work-restore/SKILL.md
```

Nếu agent chưa nhận ra skill mới, mở lại phiên agent rồi thử gọi tên skill. Kiểm tra file và kết quả lệnh vẫn là cách xác minh đã cập nhật; chỉ khởi động lại phiên không cài thêm asset.

Với dự án khác đã cài AI-DLC, chạy CLI build của repo này với đường dẫn tuyệt đối của dự án đó, thay cho `.`. Mỗi dự án có kho local riêng. Hướng dẫn này mặc định áp dụng cho repo đang mở.

## 2. Khởi tạo kho local

Sau khi `work.mjs` đã có trong `.agents`, chạy:

```sh
node .agents/aidlc/scripts/work.mjs init --root . < /dev/null
node .agents/aidlc/scripts/work.mjs preflight --root . < /dev/null
node .agents/aidlc/scripts/work.mjs search --root . < /dev/null
```

`init` bật local work trong `.agents/config.json` và tạo `.agents/data/work/`. `preflight` cần trả `"ok":true` và `"ready":true`. `search` trả danh sách công việc; kho mới có danh sách rỗng.

Trong Windows PowerShell, dùng `'{}' | node .agents/aidlc/scripts/work.mjs init --root .`; áp dụng cách đưa JSON qua stdin tương tự cho các lệnh khác. Các ví dụ shell bên dưới dùng Bash/zsh hoặc WSL.

`init` giữ nguyên cấu hình ngoài `personalWork` và giữ store UUID khi chạy lại. Tuy nhiên, nó đặt `personalWork` về các mặc định local. Nếu muốn tùy chỉnh capture/limits, sửa sau bước init và không chạy lại init để kiểm tra; dùng preflight.

Phần cấu hình tối thiểu sau init có dạng sau. Đây chỉ là phần `personalWork`, không thay toàn bộ config bằng ví dụ này:

```json
{
  "personalWork": { "enabled": true, "provider": "local" }
}
```

Bỏ `personalWork` hoặc đặt `enabled:false` sẽ tắt các tiện ích. Không cần trường credentials, providerOptions, target ID hoặc đường dẫn kho tùy chỉnh.

| Tùy chọn bên trong `personalWork` | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `capture.preserveRawSource` | `true` | Giữ body nguồn sau khi lọc các secret dễ nhận biết; `false` lưu bản tóm tắt khi intake. |
| `capture.autoReady` | `true` | Việc mới có đủ mô tả/kết quả/bước tiếp theo có thể vào READY. |
| `limits.doing` | `2` | Cảnh báo khi có nhiều việc DOING; không chặn bắt đầu. |
| `limits.searchItems` | `500` | Số item tối đa trong một lần quét. |
| `limits.contextRecords` | `200` | Số record context trả về; checkpoint mới nhất vẫn được giữ trong cửa sổ này. |
| `limits.intakeMessages` | `50` | Số tin nhắn tối đa trong một batch. |
| `limits.resumeContextChars` | `12000` | Ngân sách ký tự cho gói ngữ cảnh restore. |

## 3. Dùng skill qua hội thoại

Cách thuận tiện nhất là nói rõ skill và công việc bạn muốn lưu. Ví dụ:

> Dùng work-intake ghi nhận tin này: “Khách báo payment retry lỗi sau timeout. Cần tái hiện lỗi và tìm nguyên nhân.” Nguồn manual, externalId payment-retry-001. Chưa bắt đầu implementation.

Agent phân loại tin, chuẩn hóa tiêu đề/tóm tắt/kết quả mong muốn/bước tiếp theo và tìm công việc liên quan trước khi tạo mới. Nó trả kết quả CREATE, UPDATE, APPEND_CONTEXT, IGNORE hoặc AMBIGUOUS cùng `ref` nếu có. Giữ `ref` để dùng lần sau.

> Dùng work-intake bổ sung log này vào item có ref ở trên. Đây là CONTEXT cho lỗi retry, không phải việc mới.

Tin có nguồn/thread/reference trùng có thể vào cùng item. Khi chỉ giống tiêu đề hoặc keyword, agent cần bạn chọn item; không tự gộp các công việc khác nhau. Gửi lại cùng nguồn ổn định không tạo thêm work/source record trùng. Batch có thể có tác động một phần nếu một bước sau thất bại; đọc lại kết quả trước khi retry.

Trước khi chuyển sang việc khác:

> Dùng work-checkpoint cho ref này. Đã tái hiện timeout, thấy cleanup vẫn chạy khi retry bắt đầu. Giả thuyết là race condition. Đang chờ log khách hàng. Bước tiếp theo: thêm transaction tracing để kiểm tra thứ tự xử lý.

Khi quay lại:

> Dùng work-restore cho ref này. Tóm tắt trạng thái, các phát hiện, vướng mắc và bước tiếp theo.

Restore ưu tiên checkpoint mới nhất. Nếu context mới vô hiệu hóa checkpoint, agent phải nêu xung đột. Context bị giới hạn được báo rõ; runtime vẫn kiểm tra explicit invalidation trong toàn journal. Checkpoint/restore không tự đổi trạng thái hoặc pause task AI-DLC.

## 4. Thử trực tiếp bằng CLI

Các lệnh `intake`, `checkpoint`, `move` có ghi dữ liệu. Chỉ chạy ví dụ này nếu bạn muốn tạo một item thử trong kho của dự án. Để thử biệt lập, dùng một project tạm đã cài workflow. Giữ input/output ở vùng private:

```sh
mkdir -p .agents/data/work/examples
```

Lưu JSON sau vào `.agents/data/work/examples/capture.json`:

```json
{
  "idempotencyKey": "vi-demo-intake-001",
  "messages": [{
    "classification": "ACTIONABLE",
    "source": {
      "source": "manual", "externalId": "vi-demo-payment-retry-001",
      "threadId": null, "author": null, "timestamp": null, "url": null,
      "body": "Payment retry lỗi sau timeout; cần tìm nguyên nhân."
    },
    "item": {
      "schemaVersion": 1,
      "title": "Ví dụ: tìm nguyên nhân payment retry",
      "summary": "Retry lỗi sau timeout",
      "expectedOutcome": "Xác định nguyên nhân",
      "nextAction": "Tái hiện timeout",
      "status": "INBOX", "priority": null, "due": null, "project": null,
      "aidlcTaskId": null, "sources": [],
      "dedupe": { "externalIds": [], "threadIds": [], "references": [], "keywords": [] }
    }
  }]
}
```

```sh
node .agents/aidlc/scripts/work.mjs intake --root . < .agents/data/work/examples/capture.json > .agents/data/work/examples/capture-result.json
node .agents/aidlc/scripts/work.mjs search --root . < /dev/null
```

Input giống hệt có thể retry; không đổi key hoặc source ID chỉ để né lỗi. Tin mới cần identity mới. Key đã dùng với nội dung khác có thể gây `WORK_IDEMPOTENCY`.

`ref` gồm provider, id và URI `aidlc-work://<storeUUID>/<workUUID>`. URI là định danh trong project, không phải link để mở browser. Để lấy ref và chuẩn bị input checkpoint/move tự động, lưu đoạn JavaScript sau vào `.agents/data/work/examples/prepare-inputs.mjs`, rồi chạy bằng Node:

```js
import { readFileSync, writeFileSync } from 'node:fs';
const base = '.agents/data/work/examples/';
const captured = JSON.parse(readFileSync(base + 'capture-result.json', 'utf8'));
const ref = captured.result?.results?.[0]?.ref;
if (!captured.ok || !ref) throw new Error('Intake chưa có ref; kiểm tra kết quả trước khi tiếp tục');
const save = (name, input) => writeFileSync(base + name, JSON.stringify(input, null, 2) + '\n');
save('ref.json', { ref });
save('checkpoint.json', {
  ref, idempotencyKey: 'vi-demo-checkpoint-001',
  checkpoint: {
    schemaVersion: 1, goal: 'Tìm nguyên nhân retry', state: 'Đã tái hiện timeout',
    completed: ['Tái hiện timeout'], observations: ['Cleanup vẫn đang chạy'],
    hypothesis: 'Race condition', blockers: ['Cần log khách hàng'], files: [], links: [],
    nextAction: 'Thêm transaction tracing', capturedAt: '2026-10-14T00:00:00Z'
  }
});
save('doing.json', { ref, status: 'DOING', intent: 'start', idempotencyKey: 'vi-demo-doing-001' });
save('waiting.json', { ref, status: 'WAITING', waitingReason: 'Chờ log khách hàng', idempotencyKey: 'vi-demo-waiting-001' });
save('done.json', { ref, status: 'DONE', idempotencyKey: 'vi-demo-done-001' });
```

```sh
node .agents/data/work/examples/prepare-inputs.mjs
node .agents/aidlc/scripts/work.mjs get --root . < .agents/data/work/examples/ref.json
node .agents/aidlc/scripts/work.mjs checkpoint --root . < .agents/data/work/examples/checkpoint.json
node .agents/aidlc/scripts/work.mjs restore --root . < .agents/data/work/examples/ref.json
```

Timestamp ở trên cố định để retry của ví dụ giữ cùng input. Với checkpoint thật, dùng thời điểm lưu thực tế; checkpoint mới dùng key mới. Không chạy lại file chuẩn bị input cho một item khác rồi tái sử dụng các key như một chính sách chung.

## 5. Trạng thái công việc và AI-DLC

| Trạng thái | Cách dùng |
| --- | --- |
| INBOX | Đã nhận nhưng còn cần làm rõ. |
| READY | Có mô tả, kết quả mong muốn và bước tiếp theo. |
| DOING | Bạn chủ động chọn/bắt đầu; CLI cần `intent: "start"` hoặc `"select"`. |
| WAITING | Đang chờ; CLI cần `waitingReason`. |
| DONE | Bạn xác nhận hoàn thành; vẫn tìm kiếm được item và lịch sử. |

Ví dụ chuyển trạng thái cho item thử:

```sh
node .agents/aidlc/scripts/work.mjs move --root . < .agents/data/work/examples/doing.json
node .agents/aidlc/scripts/work.mjs move --root . < .agents/data/work/examples/waiting.json
node .agents/aidlc/scripts/work.mjs move --root . < .agents/data/work/examples/done.json
```

Qua hội thoại, nói “bắt đầu item này” hoặc “chuyển item này sang WAITING vì chờ log”. Không vào DOING chỉ vì tin có vẻ khẩn cấp. Giới hạn DOING là cảnh báo.

Personal work và task implementation là hai lớp riêng. Khi muốn viết code, nói rõ “tôi chọn item này để implement”. Agent tạo/chọn task AI-DLC qua workflow thông thường và viết intent trước khi gọi `link` với `ref`, `taskId`, `intent:"implement"` và `idempotencyKey`. Work ghi task ID; intent ghi work ref. Nếu chỉ một bên được cập nhật, đối chiếu rồi retry có chủ đích.

READY không phải duyệt G0; DONE không phải duyệt G2. Tự động DONE cho item đã liên kết cần kiểm tra task AI-DLC mới nhất thực sự hoàn tất thành công. Lưu checkpoint không tự pause lifecycle; restore không tự bắt đầu implementation.

## 6. Dữ liệu, repair và backup

Kho `.agents/data/work/` chứa `store.json` và các thư mục UUID của work item. `events.jsonl` là lịch sử có thẩm quyền. `item.json`, `sources.jsonl`, `checkpoints.jsonl` là các bản đọc dễ nhìn được dựng từ journal; sửa tay chúng không đổi công việc.

Kho có `.gitignore` mặc định để giữ dữ liệu riêng tư. File input/output của ví dụ ở dưới kho cũng được ignore. Không commit log khách hàng hoặc thông tin nhạy cảm. Runtime lọc secret dễ nhận biết trước khi lưu, nhưng không bảo đảm phát hiện mọi thông tin nhạy cảm.

Nếu journal đã ghi nhưng projection chưa cập nhật, sửa quyền/path gây lỗi rồi chạy:

```sh
node .agents/aidlc/scripts/work.mjs repair --root . < /dev/null
```

Repair dựng lại projection, không sửa journal hỏng và không xóa lịch sử. Backup bằng cách sao chép **toàn bộ** `.agents/data/work/`, gồm `store.json` và journal, khi không còn writer hoạt động. Khi phục hồi, giữ store UUID từ backup; không chỉ chép một item sang kho khác hoặc Git-merge nhiều store. Task/state AI-DLC cần backup riêng theo chính sách dự án.

Nhiều process trên cùng host dùng khóa chung cho kho. Không hỗ trợ NFS, writer phân tán hoặc đồng bộ Git tự động. Event tối đa 16000 ký tự, journal item tối đa 16 MiB, tổng journal đọc cho một search tối đa 64 MiB. Đọc bị giới hạn được báo incomplete; không tự cắt bỏ lịch sử để tiếp tục ghi.

## 7. Các lỗi thường gặp

| Kết quả/lỗi | Bước tiếp theo |
| --- | --- |
| Không tìm thấy `work.mjs` hoặc skill | Workflow managed chưa có asset; thực hiện bước cập nhật ở mục 1. |
| `WORK_DISABLED` | Chạy init nếu muốn bật local; kiểm tra personalWork.enabled. |
| `WORK_NOT_INITIALIZED` | Chạy init để tạo metadata của kho. |
| `WORK_CONFIG` | Kiểm tra provider local, capture/limits; bỏ các trường credential/target cũ. |
| `INVALID_INPUT` | Kiểm tra JSON và schema; DOING cần intent, WAITING cần reason. |
| `AMBIGUOUS` / `WORK_AMBIGUOUS` | Chọn item rõ ràng; không tạo thêm để tránh đối chiếu. |
| `WORK_IDEMPOTENCY` | Key đã dùng với input khác; đọc lại tác động cũ, dùng key mới cho thay đổi mới. |
| `WORK_TARGET` | Ref thuộc store khác; dùng ref của đúng dự án. |
| `WORK_LOCKED` | Kiểm tra writer/owner, không xóa lock khi process còn chạy. Lock không đọc được cần kiểm tra thủ công trước khi phục hồi. |
| `WORK_INCOMPLETE` / `WORK_LIMIT` | Chọn item cụ thể hoặc xem xét tăng giới hạn phù hợp; không suy luận item chưa tồn tại từ một search incomplete. |
| `WORK_UNCERTAIN` | Đọc lại/reconcile trước khi retry vì publish có thể đã xảy ra. |
| `WORK_CORRUPT` | Dừng ghi và phục hồi backup đã kiểm tra; không xóa dòng journal để bỏ qua lỗi. |
| `WORK_CONFLICT` / `WORK_LIFECYCLE` | Đối chiếu dữ liệu hoặc task AI-DLC đang liên kết trước khi tiếp tục. |

Nếu lệnh trả `ok:false`, giữ mã lỗi và thông báo để trao đổi với agent; tránh gửi nguyên log chứa thông tin riêng tư. Xem [command reference](./command-reference.md) và [hướng dẫn tiếng Anh](./personal-work-orchestration.md) khi cần tra cứu thêm.
