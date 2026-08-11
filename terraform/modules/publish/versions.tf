terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"

      # us-east-1 のプロバイダを受け取らない。ここが作るのは実行環境だけで、
      # 証明書も CloudFront のディストリビューションも持たない。
      # 触れるのは delivery が作ったものへ「無効化を投げる権限」までである。
    }
  }
}
