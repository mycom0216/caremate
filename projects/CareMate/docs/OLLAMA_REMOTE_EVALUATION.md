# 원격 Ollama 모델 평가 설정

2026-11-26 첫 원격 실행은 Ollama 설치 및 API 기동에 성공했으나 `kanana2:3b` 모델 manifest를 다운로드하지 못해 평가 전에 실패했다. [실행 로그](https://github.com/mycom0216/caremate/actions/runs/45737486990).

원격 평가에서는 공개 Ollama 모델 `qwen2.5:3b`를 사용한다. https://ollama.com/library/qwen2.5:3b
로컬 기본 모델 `kanana2:3b`는 유지하고, 평가 도구에 `LLM_MODEL` 환경변수 전달을 추가했다. 새 평가 결과는 기존 Kanana 평가와 구분한다. 원격 실행 성공 및 결과 확인 전까지 새 모델의 성능 수치는 미확정이다.
