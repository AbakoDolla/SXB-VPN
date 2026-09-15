package android.content.pm

class ApplicationInfo(val uid: Int = 1000, val packageName: String = "fixture")
class PackageManager {
    fun getInstalledApplications(flags: Int): List<ApplicationInfo> = emptyList()
    fun getPackagesForUid(uid: Int): Array<String> = emptyArray()
    fun getApplicationInfo(name: String, flags: Int) = ApplicationInfo(packageName = name)
    fun getApplicationLabel(info: ApplicationInfo): CharSequence = info.packageName
}
