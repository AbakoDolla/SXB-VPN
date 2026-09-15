package android.content

import android.content.pm.PackageManager

abstract class Context {
    companion object { const val MODE_PRIVATE = 0 }
    val packageManager = PackageManager()
    abstract fun getSharedPreferences(name: String, mode: Int): SharedPreferences
}

interface SharedPreferences {
    fun getLong(key: String, fallback: Long): Long
    fun edit(): Editor
    interface Editor {
        fun putLong(key: String, value: Long): Editor
        fun commit(): Boolean
    }
}
