@echo off
chcp 65001 >nul
rem 시작하기.cmd - Windows 에서 더블클릭만으로 CareMate 를 실행하는 배치 파일
rem 순서: 1) 현재 폴더를 이 파일이 있는 폴더로 이동 2) Node.js 설치 여부 확인(없으면 안내 후 종료)
rem       3) 브라우저로 로컬 주소 열기 4) 서버 실행(종료는 이 창에서 Ctrl+C) 5) 서버가 끝나면 창이 바로 닫히지 않게 대기
rem 위의 chcp 65001 은 콘솔을 UTF-8 로 바꿔 한글 메시지가 깨지지 않게 하는 설정입니다.
cd /d "%~dp0"
rem where node 로 node 실행 파일이 있는지 확인하고, 없으면 설치 안내 후 pause 로 멈춘 다음 오류 코드 1 로 종료합니다.
where node >nul 2>nul || (echo Node.js 24 이상이 필요합니다. https://nodejs.org 에서 설치하세요. & pause & exit /b 1)
echo CareMate를 시작합니다. 종료하려면 이 창에서 Ctrl+C 를 누르세요.
rem 기본 브라우저로 서버 주소를 엽니다(서버가 아직 시작 중일 수 있어 처음엔 새로고침이 필요할 수도 있습니다).
start "" http://127.0.0.1:5200
rem 서버 실행. 이 명령은 서버가 종료될 때까지 끝나지 않습니다.
node server.mjs
rem 서버 종료 후 창이 바로 닫히지 않게 키 입력을 기다립니다(오류 메시지를 읽을 수 있게 함).
pause
