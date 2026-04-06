# VCP每日热点自动归档工具 演示代码
import os
import requests
from datetime import datetime
from dotenv import load_dotenv

# 加载环境变量配置
load_dotenv()
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")
TAVILY_API_URL = "https://api.tavily.com/search"

def search_daily_hotspots(date_str: str, max_results: int = 15) -> dict:
    """调用Tavily搜索API获取指定日期的全网热点新闻"""
    if not TAVILY_API_KEY:
        raise ValueError("请在.env文件中配置TAVILY_API_KEY")
    
    payload = {
        "api_key": TAVILY_API_KEY,
        "query": f"{date_str} 国内国际热点新闻汇总",
        "search_depth": "basic",
        "topic": "news",
        "max_results": max_results,
        "country": "china",
        "time_range": "day"
    }
    
    try:
        response = requests.post(TAVILY_API_URL, json=payload, timeout=30)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"搜索请求失败: {str(e)}")
        return {}

def generate_markdown_report(hotspot_data: dict, date_str: str) -> str:
    """将搜索结果转换为格式化的Markdown报告"""
    md_content = f"# {date_str} 全网热点新闻汇总\n\n"
    md_content += "---\n\n"
    md_content += "## 热点概览\n\n"
    
    # 分类整理结果
    for idx, item in enumerate(hotspot_data.get("results", []), 1):
        title = item.get("title", "无标题")
        content = item.get("content", "无内容摘要")
        url = item.get("url", "无来源链接")
        md_content += f"### {idx}. {title}\n"
        md_content += f"{content}\n"
        md_content += f"[来源链接]({url})\n\n"
    
    md_content += "---\n"
    md_content += f"*报告生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | 数据来源: Tavily搜索*\n"
    return md_content

def save_report_to_file(md_content: str, date_str: str) -> str:
    """将Markdown报告保存到本地文件"""
    file_name = f"热点报告_{date_str}.md"
    with open(file_name, "w", encoding="utf-8") as f:
        f.write(md_content)
    return file_name

if __name__ == "__main__":
    # 获取当前日期
    current_date = datetime.now().strftime("%Y-%m-%d")
    print(f"正在获取 {current_date} 热点新闻...")
    
    # 执行搜索
    hotspot_data = search_daily_hotspots(current_date)
    if not hotspot_data:
        print("获取热点数据失败，请检查配置后重试")
        exit(1)
    
    # 生成报告
    md_report = generate_markdown_report(hotspot_data, current_date)
    
    # 保存文件
    saved_file = save_report_to_file(md_report, current_date)
    print(f"热点报告已生成并保存为: {saved_file}")