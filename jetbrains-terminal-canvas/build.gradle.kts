plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.25"
    id("org.jetbrains.intellij.platform") version "2.2.1"
}

group = "com.terminalcanvas"
version = "1.0.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(17))
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.1")
    }
    // pty4j is bundled with IntelliJ (with native libs) — compile-only, not bundled
    compileOnly("org.jetbrains.pty4j:pty4j:0.12.13")
    // gson is also bundled with IntelliJ
    compileOnly("com.google.code.gson:gson:2.10.1")
}

kotlin {
    jvmToolchain(17)
}

tasks {
    patchPluginXml {
        sinceBuild.set("233")
        untilBuild.set("251.*")
    }

    runIde {
        jvmArgs("-Xmx2g")
    }

    withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    withType<JavaCompile> {
        sourceCompatibility = "17"
        targetCompatibility = "17"
    }
}

intellijPlatform {
    pluginConfiguration {
        name = "Terminal Canvas"
        ideaVersion {
            sinceBuild = "233"
            untilBuild = "251.*"
        }
    }
}
