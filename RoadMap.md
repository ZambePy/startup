# IrisFlow — Plano de Sprints: Convergência para Arquitetura WebEyeTrack

## Contexto

Produto AAC de rastreamento ocular via webcam comum para pessoas com ELA (cabeça estática), sem hardware proprietário.

- **Stack atual:** Vite + TypeScript + MediaPipe Tasks Vision
- **Migração futura:** Electron (offline, local)
- **Referência arquitetural:** WebEyeTrack (Vanderbilt, 2025) — código MIT, 2,32 cm no GazeCapture com adaptação few-shot de 9 amostras

---

## 0. Diagnóstico consolidado do MVP atual

Em ordem de impacto estimado no erro percebido:

| # | Gargalo | Evidência no código | Efeito |
|---|---------|---------------------|--------|
| G1 | Seleção por piscada em starvation | `main.ts` descarta o frame quando o extractor detecta blink, antes de `updateDwell()` rodar; `dwell.ts` exige 3 frames consecutivos de EAR baixo que nunca chegam até ele | O mecanismo central de seleção provavelmente nunca dispara |
| G2 | Cascata de 4 filtros | buffer 6 frames → Kalman → EMA (α=0.05 com teclado) → lerp 0.02 | Latência de segundos; cursor nunca está onde o usuário olha |
| G3 | Instrumento de medição infla acurácia | `accuracy.ts` mede `mapGaze()` cru; erro = distância da média das predições (elimina precisão); ponto sem predição conta erro 0 | Decisões arquiteturais sobre números errados |
| G4 | Rótulos contaminados na calibração dinâmica | `weight` calculado mas descartado; frames de trânsito rotulados com posição instantânea da bolinha, ignorando latência de perseguição (~100–150ms) | Erro sistemático em ~metade do treino |
| G5 | Translação 3D da cabeça descartada | Rotação/escala normalizadas, mas `position3D` não entra nas features | Mudança de postura entre sessões desloca todo o mapeamento |
| G6 | Regressor sem validação | λ=1.0 fixo, ~258 features colineares, sem LOO-CV | Teto do modelo linear não explorado |
| G7 | Clamp mascara extrapolação | Saturação [0,1] antes da média binocular | Compressão sistemática de bordas/cantos |
| G8 | Viewport inconsistente | `innerWidth` na calibração vs `clientWidth` na predição | Deslocamento com scrollbar |

### Restrição de licença

O branch `web` é limpo (MediaPipe Apache 2.0 + dados do usuário). O branch `v3/ONNX` depende de MPIIFaceGaze/GazeFollower (não-comerciais). Os pesos publicados do WebEyeTrack também vêm de datasets não-comerciais — MIT cobre o código, não limpa os pesos.

**Caminho viável:** arquitetura WebEyeTrack + dados próprios.

### Especificidade ELA (cabeça estática)

- A maior fonte de erro da literatura (movimento intra-sessão) é quase nula → teto de acurácia melhor que benchmarks publicados
- A variância inter-sessão de postura vira a fonte dominante de drift → head pose métrico como ferramenta de recalibração rápida
- Fadiga é restrição de primeira classe: calibração ≤9 pontos, zero recalibração forçada
- Blink é canal de comando: supressão de predição e detecção de blink intencional precisam ser o mesmo subsistema com estados distintos

---

## Sprint 1 — Instrumento de medição honesto ✅ CONCLUÍDA

**Objetivo:** o número reportado corresponder à realidade, separando acurácia de precisão (como Kaduk 2024 e WebEyeTrack reportam).

**Tarefas:**
1. Corrigir o bug do erro-zero (ponto sem predição = `invalid`, excluído da média)
2. Reportar por ponto: acurácia (centroide→alvo) e precisão (RMS intra-ponto)
3. Modo "produção": medir a saída pós-filtros lado a lado com a crua — a diferença quantifica o custo da suavização
4. Log JSON exportável (features, predições, timestamps, EAR) — base do futuro dataset
5. px→cm/graus pela distância estimada via IOD em vez da constante `ASSUMED_DIST_PX`

**Gate:** relatório com acurácia e precisão separadas, cru vs pós-filtros, em ≥3 sessões reais.

### Relatório de conclusão

**Tarefa 1 — Bug do erro-zero corrigido** (`accuracy.ts`)
O tipo de `pointErrors` passou de `number[]` para `(number | null)[]`. Quando nenhum frame com predição é coletado em um ponto (`rawX.length === 0`), o valor empurrado é `null`. A função `finishTest` filtra os nulos antes de calcular a média — pontos inválidos não inflam a acurácia. O overlay mostra `—` em vez de `0px` nesses casos, com a classe `.diag-invalid`.

**Tarefa 2 — Acurácia vs Precisão por ponto** (`accuracy.ts`)
- **Acurácia** = distância do centroide das predições até o alvo (erro sistemático)
- **Precisão** = RMS das predições em torno do centroide (espalhamento intra-ponto)
O overlay exibe ambas por ponto (`123px` / `±45px`) e no resumo como `Acurácia` e `Precisão RMS` separados.

**Tarefa 3 — Modo produção: cru vs filtrado** (`accuracy.ts`, `main.ts`)
Nova função `feedAccuracyFiltered(x, y)` exportada de `accuracy.ts` e chamada em `main.ts` após o lerp (posição final do cursor). O teste captura em paralelo o centroide do stream cru (saída direta do modelo ridge) e o centroide do stream filtrado (após buffer ponderado + Kalman + lerp). O SVG exibe pontos verdes (cru) e âmbar tracejado (filtrado). A métrica `Filtrado` no resumo quantifica o custo/ganho dos filtros.

**Tarefa 4 — Log JSON exportável** (`sessionLog.ts` novo, `main.ts`)
- `L` inicia/pausa a gravação (indicador vermelho `● REC` no canto superior esquerdo)
- `E` exporta `irisflow_<timestamp>.json`
- Cada frame grava: `t` (ms), `featuresLeft`, `featuresRight`, `predRaw`, `predFiltered`, `ear`, `blinkDetected`, `keyboardVisible`, `inAccuracyTest`
- No overlay de diagnóstico, botão **Exportar Log de Sessão** aparece se gravação estiver ativa
- Botão **Salvar Relatório** exporta o resultado do teste de acurácia como JSON estruturado

**Tarefa 5 — px→cm/graus via IOD estimado** (`accuracy.ts`)
Nova função `feedAccuracyIod(iod)` recebe o `rawIod` de `main.ts` a cada frame. Fórmula: `distancePx = 2268 × 0.08 / avgIod` — proporcional ao IOD real medido, em vez de constante fixa. O valor estimado em cm aparece no painel como **Distância Est.**

**Arquivos modificados/criados:**
- `src/sessionLog.ts` — novo: log frame a frame, toggle e export
- `src/accuracy.ts` — reescrito: todas as 5 correções + export de relatório JSON
- `src/extractor.ts` — adição mínima: campo `ear: number` em `ExtractorResult`
- `src/main.ts` — atualizado: alimenta IOD, posição filtrada e log de sessão
- `src/style.css` — atualizado: `.diag-invalid`, `.export-btn`, `.log-indicator`, `.diag-point-precision`

---

## Sprint 2 — Um filtro, um detector de blink ✅ CONCLUÍDA

**Objetivo:** eliminar G1 e G2 — o par de correções com maior efeito percebido por custo.

**Tarefas:**
1. Substituir a cascata por `OneEuroFilter` único (já validado no v3; mesma escolha do GazeFollower), com `mincutoff`/`beta` expostos no painel para ajuste por terapeuta
2. `dwell` consome a saída do filtro diretamente
3. Unificar blink num módulo com máquina de estados `OPEN → CLOSING → CLOSED(n) → OPENING`, com saídas separadas:
   - `suppressGaze` — congela predição no último valor válido (como o WebEyeTrack)
   - `intentionalBlink` — fechamento ≥N frames, para seleção
   - O frame não é descartado do loop, só a predição é suprimida
4. Um único gerenciador de dwell com zonas registráveis

**Gate:** blink intencional dispara ≥95% em 20 piscadas de teste; latência sacada→cursor <150ms; frase digitada no teclado sem seleção acidental.

### Relatório de conclusão

**Tarefa 1 — OneEuroFilter substituindo a cascata** (`src/oneEuroFilter.ts` novo, `main.ts`)
A cascata de 4 filtros (buffer 6 frames → Kalman → EMA → lerp 0.02) foi removida completamente. O `OneEuroFilter2D` a substitui com um único passe adaptativo: em repouso usa cutoff baixo (suave), em sacadas rápidas aumenta o cutoff (responsivo). Parâmetros padrão: `mincutoff=0.5 Hz`, `beta=0.007`. Dois sliders no painel lateral permitem ajuste em tempo real pelo terapeuta sem reiniciar a sessão. A latência estimada em sacadas passa de ~400–800ms para <100ms.

**Tarefa 2 — Dwell consome saída do filtro** (`src/dwell.ts`, `main.ts`)
`dwell.ts` foi simplificado para lidar exclusivamente com dwell time (blink removido). Recebe `(gazeX, gazeY)` — já filtrado pelo OneEuroFilter — em vez de landmarks brutos. O `DwellManager.ts` do teclado também consome a mesma posição filtrada.

**Tarefa 3 — BlinkDetector: máquina de estados** (`src/blinkDetector.ts` novo, `main.ts`)
Máquina de estados `OPEN → CLOSING → CLOSED → OPENING` com threshold adaptativo (baseline × 0.75). Parâmetros: `MIN_CLOSING_FRAMES=2`, `MIN_INTENTIONAL=3` (~100ms), `MAX_INTENTIONAL=12` (~400ms), `COOLDOWN=18` frames (~600ms). Saídas:
- `suppressGaze`: durante qualquer estado ≠ OPEN, o cursor congela em `lastValidX/Y` — o frame **não é descartado** do loop de processamento
- `intentionalBlink`: só dispara no frame de transição CLOSED→OPENING, com cooldown para evitar duplo-disparo

**Tarefa 4 — Gerenciador de dwell com zonas registráveis** (`src/keyboard/DwellManager.ts`)
`DwellManager.update(x, y, immediateSelect)` aceita o flag `immediateSelect` (true quando `intentionalBlink`). Se o cursor está sobre um `.dwell-target` e `immediateSelect=true`, dispara a tecla imediatamente sem aguardar o dwell de 500ms. Qualquer elemento com classe `.dwell-target` é automaticamente uma zona registrável.

**Arquivos criados/modificados:**
- `src/oneEuroFilter.ts` — novo: `OneEuroFilter`, `OneEuroFilter2D`, singleton `gazeFilter`, `setGazeFilterParams`
- `src/blinkDetector.ts` — novo: `BlinkDetector` (state machine), singleton `blinkDetector`
- `src/dwell.ts` — simplificado: blink removido, só dwell time
- `src/keyboard/DwellManager.ts` — atualizado: parâmetro `immediateSelect` para seleção por blink
- `src/calibration.ts` — adicionado: `addFilterControls()` com sliders mincutoff/beta
- `src/main.ts` — reescrito: cascata removida, OneEuroFilter + BlinkDetector integrados, G1 corrigido
- `src/style.css` — adicionado: estilos para controles do filtro (sliders)

---

## Sprint 3 — Qualidade dos dados de calibração

**Objetivo:** eliminar G4, G6, G7, G8 — extrair o máximo do linear antes de trocar de modelo. Esta é a baseline justa contra a qual o neural terá que provar valor.

**Tarefas:**
1. Descartar amostras de trânsito (só `dynamicIsFixation`) ou weighted ridge (√w nas linhas de Φ e y) — começar pelo descarte e comparar
2. Descartar os primeiros ~300ms de cada fixação e frames com fechamento parcial
3. λ por LOO-CV (fórmula fechada, barato)
4. Trocar o clamp por flag de baixa confiança fora do hull de calibração (o teclado exige dwell maior em vez de "chutar" o canto)
5. Helper único de viewport
6. Reavaliar o threshold de variância que reinicia pontos

**Gate:** melhora mensurável vs baseline da Sprint 1, mesmos usuários. Documentar: "modelo linear no seu máximo".

---

## Sprint 4 — Head pose métrico (WebEyeTrack adaptado a cabeça estática)

**Objetivo:** eliminar G5 com a técnica central do WebEyeTrack, na versão pragmática: facial transformation matrix + profundidade por íris (~4,3% de erro relativo de distância).

**Tarefas:**
1. Distância câmera–rosto em cm pelo diâmetro da íris (invariante ~11,7mm, landmarks 468–477)
2. Adicionar `[tx, ty, tz]` métricos + distância ao vetor de features
3. Recalibração expressa inter-sessão: ao carregar perfil, comparar head pose atual vs o da calibração; delta acima do limiar → oferta de recalibração de 5 pontos que só reajusta bias/ganho (economia de fadiga)
4. Persistir head pose de referência no perfil

**Gate:** calibrar, deslocar câmera/cadeira ~10cm, recuperar ≥80% da acurácia com os 5 pontos.

---

## Sprint 5 — Trilha neural: gate de decisão com encoder congelado

**Objetivo:** responder uma única pergunta — "embedding CNN supera o linear otimizado da Sprint 3?" — pelo caminho mais barato e sem depender de dados multi-pessoa.

**Tarefas:**
1. Recuperar o artefato `.onnx` do encoder no repositório v3 (só o export; o código de treino fica onde está)
2. Portar inferência para o browser via ONNX Runtime Web (WebGPU com fallback WASM)
3. Personalização por usuário via ridge/KRR sobre `[embedding ‖ head pose métrico]`, treinado na calibração de 9 pontos — reusa a infra de calibração existente, sem MAML
4. A/B pelo instrumento da Sprint 1: linear/landmarks (S3) vs ridge/embeddings, mesmos usuários
5. Plano B somente se o `.onnx` for irrecuperável: treinar BlazeGaze-mini uma vez em dataset público, marcado como experimental, proibido em build de release

**Gate:** embeddings batem landmarks em acurácia E precisão com ≥25fps sem GPU. Se não baterem, a trilha neural é arquivada com evidência e o produto segue linear — e as Sprints 6/7 se simplificam.

---

## Sprint 6 — Base de dados própria (agora com piloto antecipado e duplo propósito)

**Mudanças em relação ao plano original:**
1. Fase piloto antecipada com 5–8 colegas assim que as aulas voltarem, antes da coleta completa — suficiente para validar a ferramenta de coleta e para os primeiros experimentos de meta-treino
2. O dataset passa a ter dois consumidores explícitos: o retreino limpo do encoder (agora na arquitetura BlazeGaze, com script de treino novo e pequeno — substitui a dependência do código de treino antigo) e o meta-treino MAML da Sprint 7, que precisa das tarefas por usuário
3. Resto igual: consentimento comercial por escrito, protocolo de cabeça apoiada, crops em vez de vídeo, versionamento com proveniência

**Gate:** encoder BlazeGaze treinado na base própria ≥ desempenho do encoder antigo no A/B da Sprint 5; proveniência arquivada.

---

## Sprint 7 — Personalização MAML + calibração contínua

**Objetivo:** O MAML migra para cá, onde os dados multi-pessoa existem.

**Tarefas:**
1. Meta-treino offline do MLP de gaze sobre embeddings do encoder limpo (k=9 suporte, 5 inner updates, como no paper)
2. Na calibração do usuário, adaptação com ≤9 pontos substitui (ou complementa) o ridge/embeddings da Sprint 5 — decidido por A/B
3. Calibração contínua por seleção confirmada usa o mesmo inner loop para micro-ajustes anti-drift
4. Telemetria de erro implícito por sessão

**Gate:** MAML ≥ ridge/embeddings com ≤9 pontos e drift ≈0 em 30min; caso contrário, ridge/embeddings + correção de bias local é o modelo de release.

---

## Sprint 8 — Electron offline + empacotamento clínico

**Tarefas:**
1. Migrar para Electron reaproveitando o renderer
2. Empacotar localmente os assets do MediaPipe — hoje o wasm e o modelo `.task` carregam de CDN (jsdelivr/googleapis), então o "offline" ainda não é verdadeiro
3. Perfis multi-usuário locais criptografados, export/import
4. Instalador com navegação 100% por olhar desde o primeiro launch
5. Compliance de release: proveniência de pesos/dados, LGPD (biometria processada localmente — documentar), posicionamento regulatório (não-dispositivo médico vs caminho ANVISA — decisão de negócio a registrar)

**Gate:** instalação e digitação end-to-end em máquina sem internet, usando apenas o olhar.

---

## Métricas norteadoras

| Métrica | Baseline (S1) | Pós-S3 (linear) | Pós-S5/S6 (neural) | Referência |
|---------|--------------|-----------------|---------------------|------------|
| Acurácia (cru) | medir | −30% | ≤2,3cm (~85px @60cm) | WebEyeTrack 2,32cm; GazeFollower 1,11cm |
| Precisão (RMS intra-ponto) | medir | estável e reportada | ≤0,5cm | Kaduk: 1,1° |
| Latência sacada→cursor | medir (est.: segundos) | <150ms | <150ms | — |
| Blink intencional detectado | medir (provável ~0, G1) | ≥95% | ≥98% | — |
| Pontos de calibração | 9+dinâmica | 9+dinâmica opcional | ≤9 | WebEyeTrack k≤9 |
| Drift em 30min | medir | documentado | ≈0 com S7 | WebGazer: 5→10cm/20min |
| FPS sem GPU | ~30 | ≥25 | ≥25 | BlazeGaze 2,4ms |

---

## Princípios transversais

- **Medir antes de otimizar:** nada muda sem baseline da S1 nos mesmos usuários
- **Gates explícitos:** fluxo diagnóstico → aprovação → correção → aprovação → implementação
- **Licença como requisito de engenharia:** proveniência de todo peso e dataset por escrito
- **ELA em primeiro lugar:** cabeça estática, fadiga real, blink como comando, cuidador como segundo usuário
- **Privacidade por arquitetura:** 100% local permanece invariante — é o diferencial
