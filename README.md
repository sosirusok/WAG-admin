# WAG Admin

WAG 고객 사이트의 문구, 서비스, 작업 사례, 진행 절차와 자주 묻는 질문을 관리하는 정적 관리자 도구입니다.

## 보안 구조

- 저장소나 배포 파일에 토큰과 비밀번호를 포함하지 않습니다.
- GitHub fine-grained personal access token으로 `sosirusok/WAG` 저장소 권한을 직접 확인합니다.
- 권장 권한은 WAG 저장소 한 개에 대한 `Contents: Read and write`뿐입니다.
- 토큰은 기본적으로 메모리에만 두고, 사용자가 선택한 경우 현재 탭의 `sessionStorage`에만 보관합니다.
- 콘텐츠 JSON과 새 이미지는 Git Data API로 하나의 커밋에 저장합니다.
- 다른 수정이 먼저 게시된 경우 강제로 덮어쓰지 않고 충돌을 알립니다.

공개된 정적 페이지에 자체 비밀번호를 넣는 방식은 보안 기능이 아니므로 사용하지 않습니다.

## 관리 주소

`https://sosirusok.github.io/WAG-admin/`
