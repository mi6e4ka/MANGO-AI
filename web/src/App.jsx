import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HashRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import {
  AppRoot,
  Avatar,
  Badge,
  Button,
  Cell,
  Headline,
  List,
  Placeholder,
  Section,
  Tabbar,
  TabsList,
  Text,
  Title,
} from '@telegram-apps/telegram-ui';
import {
  analyzeMango,
  b64ToImageSrc,
  fetchMango,
  fetchMangoes,
  formatFoundBy,
  formatDateTime,
  imageUrl,
} from './api.js';

const BOTTOM_TABS = [
  { path: '/camera', label: 'Камера', icon: '📷' },
  { path: '/found/mine', label: 'Найденные', icon: '🧩' },
];

const SCOPE_TABS = [
  { id: 'mine', label: 'Мои' },
  { id: 'all', label: 'Все' },
];

export default function App() {
  useTelegramWebApp();

  return (
    <AppRoot className="app-root">
      <HashRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/camera" replace />} />
          <Route
            path="/camera"
            element={
              <PageShell title="Камера">
                <CameraPage />
              </PageShell>
            }
          />
          <Route path="/found" element={<Navigate to="/found/mine" replace />} />
          <Route
            path="/found/:scope"
            element={
              <PageShell title="Найденные">
                <FoundListPage />
              </PageShell>
            }
          />
          <Route path="/detect/:uuid" element={<DetectResultPage />} />
          <Route path="/item/:uuid" element={<ItemDetailPage />} />
          <Route path="*" element={<Navigate to="/camera" replace />} />
        </Routes>
      </HashRouter>
    </AppRoot>
  );
}

function useTelegramWebApp() {
  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    tg.ready();
    tg.expand();
    tg.setHeaderColor?.('secondary_bg_color');
    tg.setBackgroundColor?.('bg_color');
  }, []);
}

function PageShell({ title, children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const onFoundTab = location.pathname.startsWith('/found');

  return (
    <div className="page-shell">
      <header className="topline">
        <Text caps weight="2" className="topline__eyebrow">
          Mango AI
        </Text>
        <Headline level="1" weight="2">
          {title}
        </Headline>
      </header>
      <main className="content">{children}</main>
      <Tabbar className="bottom-tabbar">
        {BOTTOM_TABS.map((tab) => {
          const selected = tab.path.startsWith(onFoundTab ? '/found' : location.pathname);
          return (
            <Tabbar.Item
              key={tab.path}
              text={tab.label}
              selected={selected}
              onClick={() => navigate(tab.path)}
            >
              <span className="tabbar-icon">{tab.icon}</span>
            </Tabbar.Item>
          );
        })}
      </Tabbar>
    </div>
  );
}

function CameraPage() {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const frozenUrlRef = useRef('');
  const navigate = useNavigate();

  const [active, setActive] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [frozenUrl, setFrozenUrl] = useState('');
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  const stopCamera = useCallback(({ keepFrozen = false } = {}) => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
    setActive(false);
    if (!keepFrozen) {
      setFrozen(false);
      if (frozenUrlRef.current) {
        URL.revokeObjectURL(frozenUrlRef.current);
        frozenUrlRef.current = '';
      }
      setFrozenUrl('');
      setError(null);
    }
  }, []);

  const openCamera = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        'Браузер не поддерживает getUserMedia или страница открыта не через HTTPS/localhost.',
      );
      return;
    }
    try {
      stopCamera();

      let deviceId = null;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devices.filter((d) => d.kind === 'videoinput');
        const backCams = videoInputs.filter((d) => d.getCapabilities?.()?.facingMode?.includes('environment'));
        const targetList = backCams.length > 0 ? backCams : videoInputs;
        if (targetList.length > 0) {
          deviceId = targetList[targetList.length - 1].deviceId;
        }
      } catch (_) {
        // enumerateDevices may fail without prior permission; fall back to facingMode
      }

      const constraints = {
        audio: false,
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
          ...(deviceId ? {} : { facingMode: { ideal: 'environment' } }),
          facingMode: { ideal: 'environment' },
        },
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setFrozen(false);
      setFrozenUrl('');
      setActive(true);
    } catch (err) {
      stopCamera();
      setError(
        err?.name === 'NotAllowedError'
          ? 'Доступ к камере запрещён. Разреши камеру в Telegram/браузере.'
          : 'Не получилось включить камеру. Проверь HTTPS и доступ к устройству.',
      );
    }
  }, [stopCamera]);

  const capturePhoto = useCallback(() => {
    const video = videoRef.current;
    if (!video || !streamRef.current || !video.videoWidth || !video.videoHeight) {
      setError('Камера ещё не готова для снимка.');
      return;
    }

    setError(null);
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setError('Не удалось создать холст для снимка.');
      return;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(async (blob) => {
      if (!blob) {
        setError('Не удалось сформировать снимок.');
        return;
      }

      if (frozenUrlRef.current) URL.revokeObjectURL(frozenUrlRef.current);
      const url = URL.createObjectURL(blob);
      frozenUrlRef.current = url;
      setFrozenUrl(url);
      setFrozen(true);
      setUploading(true);
      setAnalyzing(true);
      stopCamera({ keepFrozen: true, keepStatus: true });

      try {
        const result = await analyzeMango(blob);
        if (result?.is_mango) {
          navigate(`/detect/${result.mango_id}`);
        } else {
          setNotFound(true);
        }
      } catch {
        setError('Не удалось отправить снимок на сервер. Проверь бэкенд и CORS.');
      } finally {
        setUploading(false);
        setAnalyzing(false);
      }
    }, 'image/jpeg', 0.94);
  }, [navigate, stopCamera]);

  const resetCamera = useCallback(() => {
    setNotFound(false);
    setError(null);
    stopCamera();
    openCamera();
  }, [openCamera, stopCamera]);

  useEffect(() => () => {
    stopCamera();
    if (frozenUrlRef.current) URL.revokeObjectURL(frozenUrlRef.current);
  }, [stopCamera]);

  if (notFound) {
    return (
      <div className="detect-not-found">
        <div className="detect-not-found__icon">🔍</div>
        <Headline level="2" weight="2">
          Объект не обнаружен
        </Headline>
        <Text className="detect-not-found__hint">
          На снимке не найдено манго. Попробуй сделать фото ещё раз — наведи камеру на объект.
        </Text>
        <Button stretched size="l" className="capture-button" onClick={resetCamera}>
          Сделать ещё фото
        </Button>
      </div>
    );
  }

  return (
    <>
      <Section>
        <div className={`camera-card ${frozen ? 'camera-card--frozen' : ''}`}>
          <div className="camera-stage">
            {frozenUrl ? (
              <img className="camera-frozen-image" src={frozenUrl} alt="Снимок с камеры" />
            ) : (
              <video
                ref={videoRef}
                className="camera-preview"
                autoPlay
                playsInline
                muted
              />
            )}
            {!active && !frozenUrl ? (
              <>
                <div className="camera-empty">📷</div>
                <div className="camera-launch-wrap">
                  <Button size="l" className="camera-launch-button" onClick={openCamera}>
                    Включить камеру
                  </Button>
                </div>
              </>
            ) : null}
            {active && !frozen ? <div className="scan-frame" /> : null}
            {frozen ? (
              <>
                {analyzing && (
                  <div className="ai-scan-overlay" aria-hidden="true">
                    <div className="ai-scan__ring ai-scan__ring--1" />
                    <div className="ai-scan__ring ai-scan__ring--2" />
                    <div className="ai-scan__ring ai-scan__ring--3" />
                    <div className="ai-scan__line" />
                    <div className="ai-scan__line ai-scan__line--secondary" />
                    <div className="ai-scan__grid" />
                  </div>
                )}
                <div className="ai-fx" aria-hidden="true">
                  <span className="ai-fx__edge" />
                  <span className="ai-fx__wave ai-fx__wave--1" />
                  <span className="ai-fx__wave ai-fx__wave--2" />
                  <span className="ai-fx__wave ai-fx__wave--3" />
                  <span className="ai-fx__core" />
                </div>
              </>
            ) : null}
            <div className="camera-capture-bar">
              <Button
                size="m"
                className="capture-button"
                onClick={capturePhoto}
                disabled={!active || frozen || uploading}
              >
                📸
              </Button>
            </div>
          </div>
        </div>
      </Section>


    </>
  );
}

function FoundListPage() {
  const { scope = 'mine' } = useParams();
  const navigate = useNavigate();
  const activeScope = scope === 'all' ? 'all' : 'mine';

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 6;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError('');
      try {
        const data = await fetchMangoes();
        if (!cancelled) setItems(Array.isArray(data) ? data : []);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Ошибка загрузки');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const visibleItems = useMemo(
    () => (activeScope === 'mine' ? items.filter((item) => item.is_mine) : items),
    [activeScope, items],
  );

  const totalPages = Math.max(1, Math.ceil(visibleItems.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pagedItems = useMemo(
    () => visibleItems.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
    [visibleItems, safePage],
  );

  useEffect(() => {
    setPage(0);
  }, [activeScope]);

  if (loading) {
    return <Placeholder header="Загрузка…" description="Получаем список объектов с сервера." />;
  }

  if (error) {
    return (
      <Placeholder
        header="Не удалось загрузить"
        description={error}
        action={
          <Button onClick={() => window.location.reload()}>Повторить</Button>
        }
      />
    );
  }

  return (
    <>
      <TabsList className="scope-tabs">
        {SCOPE_TABS.map((tab) => (
          <TabsList.Item
            key={tab.id}
            selected={activeScope === tab.id}
            onClick={() => navigate(`/found/${tab.id}`)}
          >
            {tab.label}
            {visibleItems.length > 0 ? ` · ${visibleItems.length}` : ''}
          </TabsList.Item>
        ))}
      </TabsList>

      {visibleItems.length === 0 ? (
        <Placeholder
          header={activeScope === 'mine' ? 'Пока пусто' : 'Нет объектов'}
          description={
            activeScope === 'mine'
              ? 'Сфотографируй манго через камеру — оно появится здесь.'
              : 'В базе пока нет найденных объектов.'
          }
        />
      ) : (
        <>
          <div className="found-grid">
            {pagedItems.map((item) => (
              <div
                key={item.mango_id}
                className="found-card"
                onClick={() => navigate(`/item/${item.mango_id}`)}
              >
                <div className="found-card__photo">
                  <img
                    src={imageUrl(item.mango_id, item.photo_id)}
                    alt={`Mango ${item.mango_id}`}
                    loading="lazy"
                  />
                  <div className="found-card__overlay">
                    <div className="found-card__username">{formatFoundBy(item.found_by)}</div>
                    <div className="found-card__time">
                      {formatDateTime(item.last_seen)}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {totalPages > 1 && (
            <div className="pagination">
              <Button
                size="s"
                mode="gray"
                disabled={safePage === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                ← Назад
              </Button>
              <Text className="pagination__info">
                {safePage + 1} / {totalPages}
              </Text>
              <Button
                size="s"
                mode="gray"
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                Далее →
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function ItemDetailPage() {
  const { uuid } = useParams();
  const navigate = useNavigate();
  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [photoIndex, setPhotoIndex] = useState(0);
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError('');
      try {
        const data = await fetchMango(uuid);
        if (!cancelled) {
          setItem(data);
          setPhotoIndex(0);
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Ошибка загрузки');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [uuid]);

  if (loading) {
    return (
      <div className="detail-shell">
        <Placeholder header="Загрузка…" description="Получаем данные объекта с сервера." />
      </div>
    );
  }

  if (error || !item) {
    return (
      <div className="detail-shell">
        <Placeholder
          header="Объект не найден"
          description={error || 'Такого UUID нет в базе данных.'}
          action={<Button onClick={() => navigate('/found/mine')}>Назад</Button>}
        />
      </div>
    );
  }

  const detections = item.detections || [];
  const current = detections[photoIndex] || {};
  const foundBy = formatFoundBy(current?.username || current?.telegram_id);

  return (
    <div className="detail-shell">
      <div className="detail-topbar">
        <Button mode="plain" onClick={() => navigate(-1)} before="←">
          Назад
        </Button>
      </div>

      {detections.length > 0 ? (
        <>
          <div className="detail-image-wrap">
            <img
              className="detail-image"
              src={b64ToImageSrc(current.photo_b64)}
              alt={`Mango ${item.mango_id} - фото ${photoIndex + 1}`}
              onLoad={(event) =>
                setDisplaySize({
                  w: event.currentTarget.naturalWidth,
                  h: event.currentTarget.naturalHeight,
                })
              }
            />
            {current.bbox && displaySize.w > 0 && displaySize.h > 0 && (
              <div
                className="detail-image__bbox"
                style={{
                  left: `${current.bbox[0] * 100}%`,
                  top: `${current.bbox[1] * 100}%`,
                  width: `${(current.bbox[2] - current.bbox[0]) * 100}%`,
                  height: `${(current.bbox[3] - current.bbox[1]) * 100}%`,
                }}
              />
            )}
          </div>

          {detections.length > 1 && (
            <div className="detail-thumbs">
              {detections.map((det, index) => (
                <button
                  key={index}
                  type="button"
                  className={`detail-thumb ${index === photoIndex ? 'detail-thumb--active' : ''}`}
                  onClick={() => setPhotoIndex(index)}
                >
                  <img src={b64ToImageSrc(det.photo_b64)} alt={`Фото ${index + 1}`} />
                </button>
              ))}
            </div>
          )}

          <Section header="Информация о детекции">
            <Cell subtitle={new Date(current.created_at).toLocaleString()}>
              Время обнаружения
            </Cell>
            {current.username ? (
              <Cell subtitle={formatFoundBy(current.username)}>Кто нашёл</Cell>
            ) : null}
            {current.telegram_id ? (
              <Cell subtitle={String(current.telegram_id)}>Telegram ID</Cell>
            ) : null}
            <Cell subtitle={`${(current.detection_confidence * 100).toFixed(1)}%`}>
              Confidence
            </Cell>
            <Cell subtitle={`${(current.similarity_score * 100).toFixed(1)}%`}>
              Similarity
            </Cell>
          </Section>

          <Section header="Об объекте">
            <Cell subtitle={<span className="mono">{item.mango_id}</span>} multiline>
              UUID
            </Cell>
            <Cell subtitle={String(detections.length)}>Всего детекций</Cell>
            <Cell subtitle={new Date(item.first_seen).toLocaleString()}>
              Впервые обнаружен
            </Cell>
          </Section>
        </>
      ) : (
        <Section>
          <Placeholder header="Нет детекций" description="У этого объекта нет сохранённых фото." />
        </Section>
      )}
    </div>
  );
}

function DetectResultPage() {
  const { uuid } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [photoIndex, setPhotoIndex] = useState(0);
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError('');
      try {
        const result = await fetchMango(uuid);
        if (!cancelled) {
          setData(result);
          setPhotoIndex(Math.max(0, (result.detections?.length ?? 1) - 1));
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Ошибка загрузки');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [uuid]);

  if (loading) {
    return (
      <div className="detect-result">
        <div className="detect-topbar">
          <Button mode="plain" onClick={() => navigate('/camera')} before="←">
            Камера
          </Button>
        </div>
        <Placeholder header="Загрузка…" description="Получаем данные объекта с сервера." />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="detect-result">
        <div className="detect-topbar">
          <Button mode="plain" onClick={() => navigate('/camera')} before="←">
            Камера
          </Button>
        </div>
        <Placeholder
          header="Не удалось загрузить"
          description={error || 'Объект не найден на сервере.'}
          action={<Button onClick={() => navigate('/camera')}>К камере</Button>}
        />
      </div>
    );
  }

  const detections = data.detections || [];
  const current = detections[photoIndex] || detections[0] || {};
  const total = detections.length;
  const bbox = current.bbox || [];
  const imageSrc = b64ToImageSrc(current.photo_b64);

  return (
    <div className="detect-result">
      <div className="detect-topbar">
        <Button mode="plain" onClick={() => navigate('/camera')} before="←">
          Камера
        </Button>
        {total > 1 ? (
          <span className="detect-result__counter">
            Фото {photoIndex + 1} / {total}
          </span>
        ) : null}
      </div>

      <div className="detect-result__image-wrap">
        {imageSrc ? (
          <img
            className="detect-result__image"
            src={imageSrc}
            alt="Детекция манго"
            onLoad={(event) =>
              setDisplaySize({
                w: event.currentTarget.naturalWidth,
                h: event.currentTarget.naturalHeight,
              })
            }
          />
        ) : (
          <div className="detect-result__no-image">Нет фото</div>
        )}
        {bbox && displaySize.w > 0 && displaySize.h > 0 ? (
          <div
            className="detect-result__bbox"
            style={{
              left: `${bbox[0] * 100}%`,
              top: `${bbox[1] * 100}%`,
              width: `${(bbox[2] - bbox[0]) * 100}%`,
              height: `${(bbox[3] - bbox[1]) * 100}%`,
            }}
          />
        ) : null}
      </div>

      {total > 1 ? (
        <div className="detect-result__thumbs">
          {detections.map((detection, index) => (
            <button
              key={index}
              type="button"
              className={`detect-result__thumb ${index === photoIndex ? 'detect-result__thumb--active' : ''}`}
              onClick={() => {
                setPhotoIndex(index);
                setImageSize({ w: 0, h: 0 });
              }}
            >
              <img src={b64ToImageSrc(detection.photo_b64)} alt={`Фото ${index + 1}`} />
            </button>
          ))}
        </div>
      ) : null}

      <Section header="Информация об объекте">
        <div className="detect-result__stats">
          <div className="detect-result__stat">
            <Text className="detect-result__stat-label">Статус</Text>
            <Title weight="2">{total > 1 ? 'Уже известен' : 'Новый объект'}</Title>
          </div>
          <div className="detect-result__stat">
            <Text className="detect-result__stat-label">Confidence</Text>
            <Title weight="2">{((current.detection_confidence ?? 0) * 100).toFixed(1)}%</Title>
          </div>
          <div className="detect-result__stat">
            <Text className="detect-result__stat-label">Similarity</Text>
            <Title weight="2">{((current.similarity_score ?? 0) * 100).toFixed(1)}%</Title>
          </div>
          <div className="detect-result__stat">
            <Text className="detect-result__stat-label">Детекций</Text>
            <Title weight="2">{total}</Title>
          </div>
        </div>
        <Cell subtitle={<span className="mono">{data.mango_id}</span>} multiline>
          UUID
        </Cell>
        {current.username ? <Cell subtitle={formatFoundBy(current.username)}>Кто нашёл</Cell> : null}
        {current.telegram_id ? (
          <Cell subtitle={String(current.telegram_id)}>Telegram ID</Cell>
        ) : null}
        {current.created_at ? (
          <Cell subtitle={new Date(current.created_at).toLocaleString()}>Время</Cell>
        ) : null}
      </Section>

      <Button stretched size="l" className="capture-button" onClick={() => navigate('/camera')}>
        Сделать ещё фото
      </Button>
    </div>
  );
}
