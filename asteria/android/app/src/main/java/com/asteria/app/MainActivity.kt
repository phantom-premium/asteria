package com.asteria.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.*
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.edit

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private lateinit var setupLayout: LinearLayout
    private lateinit var serverUrlInput: EditText

    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var pendingPermissionRequest: PermissionRequest? = null

    private val prefs by lazy { getSharedPreferences("asteria_prefs", MODE_PRIVATE) }

    private val fileChooserLauncher = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data
        val results: Array<Uri>? = when {
            result.resultCode != Activity.RESULT_OK -> null
            data?.dataString != null -> arrayOf(Uri.parse(data.dataString))
            data?.clipData != null -> {
                val clip = data.clipData!!
                Array(clip.itemCount) { i -> clip.getItemAt(i).uri }
            }
            else -> null
        }
        filePathCallback?.onReceiveValue(results)
        filePathCallback = null
    }

    private val permissionLauncher = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        // Независимо от системного ответа — передаём решение обратно в WebView
        pendingPermissionRequest?.let { req ->
            req.grant(req.resources)
        }
        pendingPermissionRequest = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        progressBar = findViewById(R.id.progressBar)
        setupLayout = findViewById(R.id.setupLayout)
        serverUrlInput = findViewById(R.id.serverUrlInput)

        configureWebView()

        findViewById<Button>(R.id.connectButton).setOnClickListener {
            val raw = serverUrlInput.text.toString().trim()
            val normalized = normalizeUrl(raw)
            if (normalized == null) {
                Toast.makeText(this, "Введите корректный адрес сервера", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            saveServerUrl(normalized)
            openServer(normalized)
        }

        val savedUrl = prefs.getString(KEY_SERVER_URL, null)
        if (savedUrl != null) {
            openServer(savedUrl)
        } else {
            showSetupScreen()
        }
    }

    private fun normalizeUrl(input: String): String? {
        if (input.isEmpty()) return null
        val withScheme = if (!input.startsWith("http://") && !input.startsWith("https://")) {
            "https://$input"
        } else input
        return try {
            val uri = Uri.parse(withScheme)
            if (uri.host.isNullOrEmpty()) null else withScheme.trimEnd('/')
        } catch (e: Exception) {
            null
        }
    }

    private fun saveServerUrl(url: String) {
        prefs.edit { putString(KEY_SERVER_URL, url) }
    }

    private fun showSetupScreen() {
        webView.visibility = View.GONE
        setupLayout.visibility = View.VISIBLE
        prefs.getString(KEY_SERVER_URL, null)?.let { serverUrlInput.setText(it) }
    }

    private fun openServer(url: String) {
        setupLayout.visibility = View.GONE
        webView.visibility = View.VISIBLE
        webView.loadUrl(url)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.setSupportMultipleWindows(false)
        settings.allowFileAccess = true
        settings.userAgentString = settings.userAgentString + " AsteriaAndroidApp/1.0"

        // Куки и сессии — общие с сайтом, чтобы работали те же логины/сессии, что и в браузере
        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(webView, true)

        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
                // Разрешаем самоподписанные сертификаты (см. generate-cert.js в проекте сервера)
                handler?.proceed()
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true) {
                    Toast.makeText(
                        this@MainActivity,
                        "Не удалось подключиться к серверу. Проверьте адрес и что сервер запущен.",
                        Toast.LENGTH_LONG
                    ).show()
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progressBar.progress = newProgress
                progressBar.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
            }

            // Доступ к камере/микрофону для звонков (WebRTC)
            override fun onPermissionRequest(request: PermissionRequest) {
                pendingPermissionRequest = request
                val needed = mutableListOf<String>()
                if (request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                    needed.add(android.Manifest.permission.CAMERA)
                }
                if (request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                    needed.add(android.Manifest.permission.RECORD_AUDIO)
                }
                if (needed.isEmpty()) {
                    request.grant(request.resources)
                } else {
                    permissionLauncher.launch(needed.toTypedArray())
                }
            }

            // Выбор файла (аватар, фото для историй)
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                this@MainActivity.filePathCallback = filePathCallback
                val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT)
                intent.type = "*/*"
                return try {
                    fileChooserLauncher.launch(intent)
                    true
                } catch (e: Exception) {
                    this@MainActivity.filePathCallback = null
                    false
                }
            }
        }
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main_menu, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.action_reload -> {
                webView.reload()
                true
            }
            R.id.action_change_server -> {
                showSetupScreen()
                true
            }
            else -> super.onOptionsItemSelected(item)
        }
    }

    override fun onBackPressed() {
        if (webView.visibility == View.VISIBLE && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    companion object {
        private const val KEY_SERVER_URL = "server_url"
    }
}
