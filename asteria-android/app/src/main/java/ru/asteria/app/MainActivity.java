package ru.asteria.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

/**
 * Простая обёртка над веб-версией Asteria: само приложение (сайт + база
 * данных) по-прежнему запускается как обычно, командой `node server.js`, на
 * вашем сервере — APK лишь открывает этот сервер в полноэкранном WebView и
 * даёт доступ к камере/микрофону/загрузке файлов, чтобы звонки, голосовые
 * сообщения и кружки работали так же, как в браузере.
 */
public class MainActivity extends AppCompatActivity {

    private static final String PREFS = "asteria_prefs";
    private static final String KEY_SERVER_URL = "server_url";
    private static final int REQ_PERMISSIONS = 1001;
    private static final int REQ_FILE_CHOOSER = 2001;
    // Адрес вашего сервера по умолчанию — при первом запуске приложение
    // подключается сюда само, без экрана ввода адреса. Сменить позже можно
    // через меню (⋮ → «Сменить сервер»).
    private static final String DEFAULT_SERVER_URL = "https://46.8.227.207:3443";

    private View setupLayout;
    private EditText serverUrlInput;
    private TextView setupErrorText;
    private Button connectButton;

    private SwipeRefreshLayout swipeRefresh;
    private WebView webView;
    private ProgressBar progressBar;

    private ValueCallback<Uri[]> fileChooserCallback;
    private String pendingServerUrl;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        setupLayout = findViewById(R.id.setupLayout);
        serverUrlInput = findViewById(R.id.serverUrlInput);
        setupErrorText = findViewById(R.id.setupErrorText);
        connectButton = findViewById(R.id.connectButton);
        swipeRefresh = findViewById(R.id.swipeRefresh);
        webView = findViewById(R.id.webView);
        progressBar = findViewById(R.id.progressBar);

        requestRuntimePermissions();

        connectButton.setOnClickListener(v -> onConnectClicked());
        swipeRefresh.setOnRefreshListener(() -> webView.reload());
        // Свайп вниз для обновления страницы конфликтовал со скроллом чата —
        // телефон путал "долистать вверх до начала переписки" с "потянуть для
        // обновления". Функция отключена полностью; обновление доступно только
        // программно (например при ошибке загрузки).
        swipeRefresh.setEnabled(false);

        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String savedUrl = prefs.getString(KEY_SERVER_URL, null);
        serverUrlInput.setText(DEFAULT_SERVER_URL);
        if (savedUrl != null) {
            showWebView(savedUrl);
        } else {
            // Первый запуск — сразу подключаемся к серверу по умолчанию, не
            // заставляя человека вводить адрес вручную.
            prefs.edit().putString(KEY_SERVER_URL, DEFAULT_SERVER_URL).apply();
            showWebView(DEFAULT_SERVER_URL);
        }
    }

    private void requestRuntimePermissions() {
        java.util.ArrayList<String> needed = new java.util.ArrayList<>();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.CAMERA);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.RECORD_AUDIO);
        }
        if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toArray(new String[0]), REQ_PERMISSIONS);
        }
    }

    private void showSetupScreen() {
        setupLayout.setVisibility(View.VISIBLE);
        swipeRefresh.setVisibility(View.GONE);
    }

    private void onConnectClicked() {
        String url = serverUrlInput.getText().toString().trim();
        if (TextUtils.isEmpty(url) || !(url.startsWith("http://") || url.startsWith("https://"))) {
            setupErrorText.setVisibility(View.VISIBLE);
            setupErrorText.setText(R.string.setup_error);
            return;
        }
        setupErrorText.setVisibility(View.GONE);
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_SERVER_URL, url).apply();
        showWebView(url);
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void showWebView(String url) {
        setupLayout.setVisibility(View.GONE);
        swipeRefresh.setVisibility(View.VISIBLE);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportMultipleWindows(false);
        s.setAllowFileAccess(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                String host = request.getUrl().getHost();
                String ourHost = Uri.parse(pendingServerUrl != null ? pendingServerUrl : url).getHost();
                if (host != null && host.equals(ourHost)) {
                    return false; // остаёмся внутри приложения
                }
                // внешняя ссылка (например, из сообщения) — открываем в обычном браузере
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                pendingServerUrl = url;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                swipeRefresh.setRefreshing(false);
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // Собственный сервер Asteria по умолчанию использует
                // самоподписанный сертификат (см. generate-cert.js) — так же,
                // как в обычном браузере, спрашиваем подтверждение вместо
                // того чтобы либо молча всё принимать, либо блокировать вход.
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle(R.string.ssl_warning_title)
                        .setMessage(R.string.ssl_warning_message)
                        .setPositiveButton(R.string.ssl_warning_proceed, (d, w) -> handler.proceed())
                        .setNegativeButton(R.string.ssl_warning_cancel, (d, w) -> handler.cancel())
                        .setCancelable(false)
                        .show();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
                progressBar.setProgress(newProgress);
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Пробрасываем запрос камеры/микрофона из WebView (нужно для
                // звонков, голосовых сообщений и кружков) — но только если
                // соответствующее системное разрешение Android уже выдано.
                runOnUiThread(() -> {
                    java.util.ArrayList<String> granted = new java.util.ArrayList<>();
                    for (String res : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)
                                && ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                            granted.add(res);
                        } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)
                                && ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                            granted.add(res);
                        }
                    }
                    if (!granted.isEmpty()) {
                        request.grant(granted.toArray(new String[0]));
                    } else {
                        request.deny();
                        requestRuntimePermissions();
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                // Загрузка фото/видео/файлов через <input type="file"> (аватар,
                // фото в чат, кастомные обои и т.д.)
                fileChooserCallback = callback;
                Intent intent = params.createIntent();
                try {
                    startActivityForResult(intent, REQ_FILE_CHOOSER);
                } catch (Exception e) {
                    fileChooserCallback = null;
                    return false;
                }
                return true;
            }
        });

        webView.setDownloadListener((dUrl, userAgent, contentDisposition, mimetype, contentLength) -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(dUrl)));
            } catch (Exception e) {
                Toast.makeText(this, dUrl, Toast.LENGTH_SHORT).show();
            }
        });

        pendingServerUrl = url;
        webView.loadUrl(url);
    }

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            if (fileChooserCallback == null) { super.onActivityResult(requestCode, resultCode, data); return; }
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                String dataString = data.getDataString();
                if (dataString != null) {
                    results = new Uri[]{Uri.parse(dataString)};
                } else if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                }
            }
            fileChooserCallback.onReceiveValue(results);
            fileChooserCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (swipeRefresh.getVisibility() == View.VISIBLE && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.main_menu, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(@NonNull MenuItem item) {
        int id = item.getItemId();
        if (id == R.id.action_reload) {
            webView.reload();
            return true;
        } else if (id == R.id.action_change_server) {
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_SERVER_URL).apply();
            webView.loadUrl("about:blank");
            serverUrlInput.setText(DEFAULT_SERVER_URL);
            showSetupScreen();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }
}
