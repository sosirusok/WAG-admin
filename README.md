# SWAG Admin

SWAG 고객 사이트의 문구, 서비스, 작업 사례, 진행 절차와 자주 묻는 질문을 관리하는 정적 관리자 도구입니다.

## 보안 구조

- 저장소나 배포 파일에 토큰과 비밀번호를 포함하지 않습니다.
- GitHub fine-grained personal access token으로 사이트 원본 저장소 권한을 직접 확인합니다.
- 권장 권한은 사이트 원본 저장소 한 개에 대한 `Contents: Read and write`뿐입니다.
- 관리 키는 현재 페이지의 메모리에서만 사용하며 브라우저 저장소, 코드나 주소에 보관하지 않습니다.
- 콘텐츠 JSON과 새 이미지는 Git Data API로 하나의 커밋에 저장합니다.
- 다른 수정이 먼저 게시된 경우 강제로 덮어쓰지 않고 충돌을 알립니다.

공개된 정적 페이지에 자체 비밀번호를 넣는 방식은 보안 기능이 아니므로 사용하지 않습니다.

## 관리 주소

`https://sosirusok.github.io/WAG-admin/`

## 글꼴

관리 화면 본문에는 Pretendard를, 브랜드와 주요 제목에는 Wanted Sans Variable을 사용합니다 각 라이선스는 `public/Pretendard-LICENSE.txt`와 `public/WantedSans-LICENSE.txt`에 포함되어 있습니다
