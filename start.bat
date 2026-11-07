@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 설치되어 있지 않습니다. Node.js 26 LTS를 설치한 뒤 다시 실행해 주세요.
  pause
  exit /b 1
)
node -e "if(Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if errorlevel 1 (
  echo Node.js 22 이상이 필요합니다. Node.js를 업데이트해 주세요.
  pause
  exit /b 1
)
if not exist "node_modules\socket.io\package.json" (
  echo 처음 실행합니다. 필요한 패키지를 설치합니다...
  npm install
  if errorlevel 1 (
    echo 패키지 설치에 실패했습니다. 인터넷 연결을 확인해 주세요.
    pause
    exit /b 1
  )
)
echo WORDLINK 서버를 시작합니다. 브라우저에서 http://localhost:3000 을 여세요.
npm start
pause
